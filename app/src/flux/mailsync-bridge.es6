import path from 'path';
import fs from 'fs';
import {ipcRenderer} from 'electron';

import Task from './tasks/task';
import TaskQueue from './stores/task-queue';
import IdentityStore from './stores/identity-store';

import Account from './models/account';
import AccountStore from './stores/account-store';
import DatabaseStore from './stores/database-store';
import OnlineStatusStore from './stores/online-status-store';
import DatabaseChangeRecord from './stores/database-change-record';
import DatabaseObjectRegistry from '../registries/database-object-registry';
import MailsyncProcess from '../mailsync-process';
import KeyManager from '../key-manager';
import Actions from './actions';
import Utils from './models/utils';

const MAX_CRASH_HISTORY = 10;

/*
This class keeps track of how often Mailsync workers crash. If a mailsync
worker exits more than 5 times in <5 minutes, we consider it "too many failures"
and won't relaunch it until:

- the user restarts the app, clearing the history
- the user changes the account's settings (updating password, etc.)
- the user explicitly says "Try Again" in the UI

*/
class CrashTracker {
  constructor() {
    this._timestamps = {};
    this._tooManyFailures = {};
  }

  forgetCrashes(fullAccountJSON) {
    const key = this._keyFor(fullAccountJSON);
    delete this._timestamps[key];
    delete this._tooManyFailures[key];
  }

  recordClientCrash(fullAccountJSON, {code, error, signal}) {
    this._appendCrashToHistory(fullAccountJSON);

    const overview = `SyncWorker crashed with ${signal} (code ${code})`;
    let [message, stack] = (`${error}`).split('*** Stack trace');

    if (message) {
      const lines = message.split('\n')
        .map(l => l.replace(/\*\*\*/g, '').trim())
        .filter(l => !l.startsWith('[') && !l.startsWith('Error: null['));
      message = `${overview}:\n${lines.join('\n')}`;
    }
    if (stack) {
      const lines = stack.split('\n')
        .map(l => l.replace(/\*\*\*/g, '').trim())
      lines.shift();
      message = `${message}${lines[0]}`;
      stack = lines.join('\n');
    }

    const err = new Error(message);
    err.stack = stack;

    let log = "";
    try {
      const logpath = path.join(NylasEnv.getConfigDirPath(), 'mailsync.log')
      const {size} = fs.statSync(logpath);
      const tailSize = Math.min(1200, size);
      const buffer = new Buffer(tailSize);
      const fd = fs.openSync(logpath, 'r')
      fs.readSync(fd, buffer, 0, tailSize, size - tailSize)
      log = buffer.toString('UTF8');
      log = log.substr(log.indexOf('\n') + 1);
    } catch (logErr) {
      console.warn(`Could not append mailsync.log to mailsync exception report: ${logErr}`);
    }

    NylasEnv.errorLogger.reportError(err, {
      stack: stack,
      log: log,
      provider: fullAccountJSON.provider,
    });
  }

  _keyFor({id, settings}) {
    return JSON.stringify({id, settings});
  }

  _appendCrashToHistory(fullAccountJSON) {
    const key = this._keyFor(fullAccountJSON);
    this._timestamps[key] = this._timestamps[key] || [];
    if (this._timestamps[key].unshift(Date.now()) > MAX_CRASH_HISTORY) {
      this._timestamps[key].length = MAX_CRASH_HISTORY;
    }

    // has the client crashed more than 5 times in the last 5 minutes?
    // If so, do not restart. We'll mark that the account is not syncing.
    if (this._timestamps[key].length >= 5 && (Date.now() - this._timestamps[key][4] < 5 * 60 * 1000)) {
      this._tooManyFailures[key] = true;
    }
  }

  tooManyFailures(fullAccountJSON) {
    const key = this._keyFor(fullAccountJSON);
    return this._tooManyFailures[key];
  }
}


export default class MailsyncBridge {
  constructor() {
    if (!NylasEnv.isMainWindow() || NylasEnv.inSpecMode()) {
      ipcRenderer.on('mailsync-bridge-message', this._onIncomingRebroadcastMessage);
      return;
    }

    Actions.queueTask.listen(this._onQueueTask, this);
    Actions.queueTasks.listen(this._onQueueTasks, this);
    Actions.cancelTask.listen(this._onCancelTask, this);
    Actions.fetchBodies.listen(this._onFetchBodies, this);

    this._crashTracker = new CrashTracker();
    this._clients = {};

    AccountStore.listen(this.ensureClients, this);
    OnlineStatusStore.listen(this._onOnlineStatusChanged, this);
    NylasEnv.onBeforeUnload(this._onBeforeUnload);

    process.nextTick(() => {
      this.ensureClients();
    });
  }

  // Public

  openLogs() {
    const {configDirPath} = NylasEnv.getLoadSettings();
    const logPath = path.join(configDirPath, 'mailsync.log');
    require('electron').shell.openItem(logPath); // eslint-disable-line
  }

  clients() {
    return this._clients;
  }

  ensureClients() {
    const clientsWithoutAccounts = Object.assign({}, this._clients);

    for (const acct of AccountStore.accounts()) {
      if (!this._clients[acct.id]) {
        // client for this account is missing, launch it!
        this._launchClient(acct);
      } else {
        // client for this account exists
        delete clientsWithoutAccounts[acct.id];
      }
    }

    // Any clients left in the `clientsWithoutAccounts` after we looped
    // through and deleted one for each accountId are ones representing
    // deleted accounts.
    for (const client of Object.values(clientsWithoutAccounts)) {
      client.kill();
    }
  }

  forceRelaunchClient(account) {
    this._launchClient(account, {force: true});
  }

  sendSyncMailNow() {
    console.warn("Sending `wake` to all mailsync workers...");
    for (const client of Object.values(this._clients)) {
      client.sendMessage({type: "wake-workers"});
    }
  }

  sendMessageToAccount(accountId, json) {
    if (!this._clients[accountId]) {
      const err = new Error(`No mailsync worker is running.`);
      err.accountId = accountId;
      NylasEnv.reportError(err);
      return;
    }
    this._clients[accountId].sendMessage(json);
  }

  // Private

  _launchClient(account, {force} = {}) {
    const fullAccountJSON = KeyManager.insertAccountSecrets(account).toJSON();
    const identity = IdentityStore.identity();
    const id = account.id;

    if (force) {
      this._crashTracker.forgetCrashes(fullAccountJSON);
    } else if (this._crashTracker.tooManyFailures(fullAccountJSON)) {
      return;
    }

    const client = new MailsyncProcess(NylasEnv.getLoadSettings(), identity, fullAccountJSON);
    client.sync();
    client.on('deltas', this._onIncomingMessages);
    client.on('close', ({code, error, signal}) => {
      delete this._clients[id];
      if (signal !== 'SIGTERM') {
        this._crashTracker.recordClientCrash(fullAccountJSON, {code, error, signal})

        const isAuthFailure = (
          `${error}`.includes("Response Code: 401") || // mailspring services
          `${error}`.includes("Response Code: 403") || // mailspring services
          `${error}`.includes("ErrorAuthentication") // mailcore
        );

        if (this._crashTracker.tooManyFailures(fullAccountJSON)) {
          Actions.updateAccount(id, {
            syncState: isAuthFailure ? Account.SYNC_STATE_AUTH_FAILED : Account.SYNC_STATE_ERROR,
            syncError: {code, error, signal},
          });
        } else {
          this.ensureClients();
        }
      }
    });
    this._clients[id] = client;

    if (fullAccountJSON.syncState !== Account.SYNC_STATE_OK) {
      // note: This call triggers ensureClients, and must go after this.clients[id] is set
      Actions.updateAccount(id, {
        syncState: Account.SYNC_STATE_OK,
        syncError: null,
      });
    }
  }

  _onQueueTask(task) {
    if (!DatabaseObjectRegistry.isInRegistry(task.constructor.name)) {
      console.log(task);
      throw new Error("You must queue a `Task` instance which is registred with the DatabaseObjectRegistry")
    }
    if (!task.id) {
      console.log(task);
      throw new Error("Tasks must have an ID prior to being queued. Check that your Task constructor is calling `super`");
    }
    if (!task.accountId) {
      throw new Error(`Tasks must have an accountId. Check your instance of ${task.constructor.name}.`);
    }

    task.validate();
    task.status = 'local';
    this.sendMessageToAccount(task.accountId, {type: 'queue-task', task: task});
  }

  _onQueueTasks(tasks) {
    if (!tasks || !tasks.length) { return; }
    for (const task of tasks) { this._onQueueTask(task); }
  }

  _onCancelTask(taskOrId) {
    let task = taskOrId;
    if (typeof taskOrId === "string") {
      task = TaskQueue.queue().find(t => t.id === taskOrId);
    }
    if (task) {
      this.sendMessageToAccount(task.accountId, {type: 'cancel-task', taskId: task.id});
    }
  }

  _onIncomingMessages = (msgs) => {
    for (const msg of msgs) {
      if (msg.length === 0) {
        continue;
      }
      if (msg[0] !== '{') {
        console.log(`Sync worker sent non-JSON formatted message: ${msg}`)
        continue;
      }

      const {type, modelJSONs, modelClass} = JSON.parse(msg);
      if (!modelJSONs || !type || !modelClass) {
        console.log(`Sync worker sent a JSON formatted message with unexpected keys: ${msg}`)
        continue;
      }

      // dispatch the message to other windows
      ipcRenderer.send('mailsync-bridge-rebroadcast-to-all', msg);

      const models = modelJSONs.map(Utils.convertToModel);
      this._onIncomingChangeRecord(new DatabaseChangeRecord({
        type, // TODO BG move to "model" naming style, finding all uses might be tricky
        objectClass: modelClass,
        objects: models}));
    }
  }

  _onIncomingChangeRecord = (record) => {
    // Allow observers of the database to handle this change
    DatabaseStore.trigger(record);

    // Run task success / error handlers if the task is now complete
    if (record.type === 'persist' && record.objects[0] instanceof Task) {
      for (const task of record.objects) {
        if (task.status !== 'complete') {
          continue;
        }
        if (task.error != null) {
          task.onError(task.error);
        } else {
          task.onSuccess();
        }
      }
    }
  }

  _onIncomingRebroadcastMessage = (event, msg) => {
    const {type, objects, objectClass} = JSON.parse(msg);
    const models = objects.map(Utils.convertToModel);
    DatabaseStore.trigger(new DatabaseChangeRecord({type, objectClass, objects: models}));
  }

  _onFetchBodies(messages) {
    const byAccountId = {};
    for (const msg of messages) {
      byAccountId[msg.accountId] = byAccountId[msg.accountId] || [];
      byAccountId[msg.accountId].push(msg.id);
    }
    for (const accountId of Object.keys(byAccountId)) {
      this.sendMessageToAccount(accountId, {type: 'need-bodies', ids: byAccountId[accountId]});
    }
  }

  _onBeforeUnload = () => {
    for (const client of Object.values(this._clients)) {
      client.kill();
    }
    this._clients = [];
    return true;
  }

  _onOnlineStatusChanged = ({onlineDidChange}) => {
    if (onlineDidChange && OnlineStatusStore.isOnline()) {
      this.sendSyncMailNow();
    }
  }
}
