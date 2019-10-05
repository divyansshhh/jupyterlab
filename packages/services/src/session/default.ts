// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.

import { each, find } from '@phosphor/algorithm';

import { ISignal, Signal } from '@phosphor/signaling';

import { Kernel, KernelMessage } from '../kernel';

import { ServerConnection } from '..';

import { Session } from './session';

import { listRunning } from './restapi';
import * as restapi from './restapi';

/**
 * Session object for accessing the session REST api. The session
 * should be used to start kernels and then shut them down -- for
 * all other operations, the kernel object should be used.
 */
export class SessionConnection implements Session.ISessionConnection {
  /**
   * Construct a new session.
   */
  constructor(
    options: Session.IOptions,
    id: string,
    model: Kernel.IModel | null
  ) {
    this._id = id;
    this._path = options.path;
    this._type = options.type || 'file';
    this._name = options.name || '';
    this._connectToKernel = options.connectToKernel;
    this.serverSettings =
      options.serverSettings || ServerConnection.makeSettings();
    this.setupKernel(model);
  }

  get disposed(): ISignal<this, void> {
    return this._disposed;
  }

  /**
   * A signal emitted when the kernel changes.
   */
  get kernelChanged(): ISignal<this, Session.IKernelChangedArgs> {
    return this._kernelChanged;
  }

  /**
   * A signal proxied from the connection about the kernel status.
   */
  get statusChanged(): ISignal<this, Kernel.Status> {
    return this._statusChanged;
  }

  /**
   * A signal proxied from the kernel about the connection status.
   */
  get connectionStatusChanged(): ISignal<this, Kernel.ConnectionStatus> {
    return this._connectionStatusChanged;
  }

  /**
   * A signal proxied from the kernel about iopub kernel messages.
   */
  get iopubMessage(): ISignal<this, KernelMessage.IIOPubMessage> {
    return this._iopubMessage;
  }

  /**
   * A signal proxied from the kernel for an unhandled kernel message.
   */
  get unhandledMessage(): ISignal<this, KernelMessage.IMessage> {
    return this._unhandledMessage;
  }

  /**
   * A signal proxied from the kernel emitted for any kernel message.
   *
   * Note: The behavior is undefined if the message is modified
   * during message handling. As such, it should be treated as read-only.
   */
  get anyMessage(): ISignal<this, Kernel.IAnyMessageArgs> {
    return this._anyMessage;
  }

  /**
   * A signal emitted when a session property changes.
   */
  get propertyChanged(): ISignal<this, 'path' | 'name' | 'type'> {
    return this._propertyChanged;
  }

  /**
   * Get the session id.
   */
  get id(): string {
    return this._id;
  }

  /**
   * Get the session kernel object.
   *
   * #### Notes
   * This is a read-only property, and can be altered by [changeKernel].
   */
  get kernel(): Kernel.IKernelConnection {
    return this._kernel;
  }

  /**
   * Get the session path.
   */
  get path(): string {
    return this._path;
  }

  /**
   * Get the session type.
   */
  get type(): string {
    return this._type;
  }

  /**
   * Get the session name.
   */
  get name(): string {
    return this._name;
  }

  /**
   * Get the model associated with the session.
   */
  get model(): Session.IModel {
    return {
      id: this.id,
      kernel: { id: this.kernel.id, name: this.kernel.name },
      path: this._path,
      type: this._type,
      name: this._name
    };
  }

  /**
   * The server settings of the session.
   */
  readonly serverSettings: ServerConnection.ISettings;

  /**
   * Test whether the session has been disposed.
   */
  get isDisposed(): boolean {
    return this._isDisposed;
  }

  /**
   * Clone the current session with a new clientId.
   */
  clone(): Session.ISessionConnection {
    return new SessionConnection(
      {
        path: this._path,
        name: this._name,
        type: this._type,
        serverSettings: this.serverSettings,
        connectToKernel: this._connectToKernel
      },
      this._id,
      { id: this.kernel.id, name: this.kernel.name }
    );
  }

  /**
   * Update the session based on a session model from the server.
   */
  update(model: Session.IModel): void {
    // Avoid a race condition if we are waiting for a REST call return.
    if (this._updating) {
      return;
    }
    let oldModel = this.model;
    this._path = model.path;
    this._name = model.name;
    this._type = model.type;

    if (
      (this._kernel === null && model.kernel !== null) ||
      (this._kernel !== null && model.kernel === null) ||
      (this._kernel !== null &&
        model.kernel !== null &&
        this._kernel.id !== model.kernel.id)
    ) {
      if (this._kernel !== null) {
        this._kernel.dispose();
      }
      let oldValue = this._kernel;
      this.setupKernel(model.kernel);
      let newValue = this._kernel;
      this._kernelChanged.emit({ name: 'kernel', oldValue, newValue });
    }

    this._handleModelChange(oldModel);
  }

  /**
   * Dispose of the resources held by the session.
   */
  dispose(): void {
    if (this.isDisposed) {
      return;
    }
    this._isDisposed = true;
    this._disposed.emit();
    this._kernel.dispose();
    Signal.clearData(this);
  }

  /**
   * Change the session path.
   *
   * @param path - The new session path.
   *
   * @returns A promise that resolves when the session has renamed.
   *
   * #### Notes
   * This uses the Jupyter REST API, and the response is validated.
   * The promise is fulfilled on a valid response and rejected otherwise.
   */
  async setPath(path: string): Promise<void> {
    if (this.isDisposed) {
      throw new Error('Session is disposed');
    }
    let data = JSON.stringify({ path });
    await this._patch(data);
  }

  /**
   * Change the session name.
   */
  async setName(name: string): Promise<void> {
    if (this.isDisposed) {
      throw new Error('Session is disposed');
    }
    let data = JSON.stringify({ name });
    await this._patch(data);
  }

  /**
   * Change the session type.
   */
  async setType(type: string): Promise<void> {
    if (this.isDisposed) {
      throw new Error('Session is disposed');
    }
    let data = JSON.stringify({ type });
    await this._patch(data);
  }

  /**
   * Change the kernel.
   *
   * @params options - The name or id of the new kernel.
   *
   * #### Notes
   * This shuts down the existing kernel and creates a new kernel,
   * keeping the existing session ID and session path.
   */
  async changeKernel(
    options: Partial<Kernel.IModel>
  ): Promise<Kernel.IKernelConnection> {
    if (this.isDisposed) {
      throw new Error('Session is disposed');
    }
    let data = JSON.stringify({ kernel: options });
    this.kernel.dispose();

    // This status is not technically correct, but it may be useful to refresh
    // clients TODO: evaluate whether we want to do this, or tell people to
    // listen to the kernelChanged signal.
    // this._statusChanged.emit('restarting');
    // TODO: probably change this to adjusting the kernel connection status.
    await this._patch(data);
    return this.kernel;
  }

  /**
   * Kill the kernel and shutdown the session.
   *
   * @returns - The promise fulfilled on a valid response from the server.
   *
   * #### Notes
   * Uses the [Jupyter Notebook API](http://petstore.swagger.io/?url=https://raw.githubusercontent.com/jupyter/notebook/master/notebook/services/api/api.yaml#!/sessions), and validates the response.
   * Disposes of the session and emits a [sessionDied] signal on success.
   */
  async shutdown(): Promise<void> {
    if (this.isDisposed) {
      throw new Error('Session is disposed');
    }
    return restapi.shutdownSession(this.id, this.serverSettings);
  }

  /**
   * Create a new kernel connection and connect to its signals.
   *
   * #### Notes
   * This method is not meant to be subclassed.
   */
  protected setupKernel(model: Kernel.IModel | null): void {
    if (model === null) {
      this._kernel = null;
      return;
    }
    const kc = this._connectToKernel(model, this.serverSettings);
    this._kernel = kc;
    kc.statusChanged.connect(this.onKernelStatus, this);
    kc.connectionStatusChanged.connect(this.onKernelConnectionStatus, this);
    kc.unhandledMessage.connect(this.onUnhandledMessage, this);
    kc.iopubMessage.connect(this.onIOPubMessage, this);
    kc.anyMessage.connect(this.onAnyMessage, this);
  }

  /**
   * Handle to changes in the Kernel status.
   */
  protected onKernelStatus(
    sender: Kernel.IKernelConnection,
    state: Kernel.Status
  ) {
    this._statusChanged.emit(state);
  }

  /**
   * Handle to changes in the Kernel status.
   */
  protected onKernelConnectionStatus(
    sender: Kernel.IKernelConnection,
    state: Kernel.ConnectionStatus
  ) {
    this._connectionStatusChanged.emit(state);
  }

  /**
   * Handle iopub kernel messages.
   */
  protected onIOPubMessage(
    sender: Kernel.IKernelConnection,
    msg: KernelMessage.IIOPubMessage
  ) {
    this._iopubMessage.emit(msg);
  }

  /**
   * Handle unhandled kernel messages.
   */
  protected onUnhandledMessage(
    sender: Kernel.IKernelConnection,
    msg: KernelMessage.IMessage
  ) {
    this._unhandledMessage.emit(msg);
  }

  /**
   * Handle any kernel messages.
   */
  protected onAnyMessage(
    sender: Kernel.IKernelConnection,
    args: Kernel.IAnyMessageArgs
  ) {
    this._anyMessage.emit(args);
  }

  /**
   * Send a PATCH to the server, updating the session path or the kernel.
   */
  private async _patch(body: string): Promise<Session.IModel> {
    this._updating = true;
    try {
      let model = await restapi.updateSession(
        this._id,
        body,
        this.serverSettings
      );
      return model;
    } finally {
      this._updating = false;
    }
  }

  /**
   * Handle a change to the model.
   */
  private _handleModelChange(oldModel: Session.IModel): void {
    if (oldModel.name !== this._name) {
      this._propertyChanged.emit('name');
    }
    if (oldModel.type !== this._type) {
      this._propertyChanged.emit('type');
    }
    if (oldModel.path !== this._path) {
      this._propertyChanged.emit('path');
    }
  }

  private _id = '';
  private _path = '';
  private _name = '';
  private _type = '';
  private _kernel: Kernel.IKernelConnection;
  private _isDisposed = false;
  private _updating = false;
  private _disposed = new Signal<this, void>(this);
  private _kernelChanged = new Signal<this, Session.IKernelChangedArgs>(this);
  private _statusChanged = new Signal<this, Kernel.Status>(this);
  private _connectionStatusChanged = new Signal<this, Kernel.ConnectionStatus>(
    this
  );
  private _iopubMessage = new Signal<this, KernelMessage.IIOPubMessage>(this);
  private _unhandledMessage = new Signal<this, KernelMessage.IMessage>(this);
  private _anyMessage = new Signal<this, Kernel.IAnyMessageArgs>(this);
  private _propertyChanged = new Signal<this, 'path' | 'name' | 'type'>(this);
  private _connectToKernel: (
    options: Kernel.IModel,
    settings?: ServerConnection.ISettings
  ) => Kernel.IKernelConnection;
}

/**
 * The namespace for `DefaultSession` statics.
 */
export namespace SessionConnection {
  /**
   * List the running sessions.
   */
  export function listRunning(
    settings?: ServerConnection.ISettings
  ): Promise<Session.IModel[]> {
    return listRunning(settings);
  }

  /**
   * Start a new session.
   */
  export function startNew(
    options: Session.IOptions
  ): Promise<Session.ISessionConnection> {
    return Private.startNew(options);
  }

  /**
   * Find a session by id.
   */
  export function findById(
    id: string,
    settings?: ServerConnection.ISettings
  ): Promise<Session.IModel> {
    return Private.findById(id, settings);
  }

  /**
   * Find a session by path.
   */
  export function findByPath(
    path: string,
    settings?: ServerConnection.ISettings
  ): Promise<Session.IModel> {
    return Private.findByPath(path, settings);
  }

  /**
   * Connect to a running session.
   */
  export function connectTo(
    model: Session.IModel,
    settings?: ServerConnection.ISettings
  ): Session.ISessionConnection {
    return Private.connectTo(model, settings);
  }

  /**
   * Shut down a session by id.
   */
  export function shutdown(
    id: string,
    settings?: ServerConnection.ISettings
  ): Promise<void> {
    return restapi.shutdownSession(id, settings);
  }

  /**
   * Shut down all sessions.
   *
   * @param settings - The server settings to use.
   *
   * @returns A promise that resolves when all the sessions are shut down.
   */
  export function shutdownAll(
    settings?: ServerConnection.ISettings
  ): Promise<void> {
    return Private.shutdownAll(settings);
  }
}

/**
 * A namespace for session private data.
 */
namespace Private {
  /**
   * Connect to a running session.
   */
  export function connectTo(
    model: Session.IModel,
    settings: ServerConnection.ISettings = ServerConnection.makeSettings()
  ): Session.ISessionConnection {
    let running = runningSessions.get(settings.baseUrl) || [];
    let session = find(running, value => value.id === model.id);
    if (session) {
      return session.clone();
    }
    return createSession(model, settings);
  }

  /**
   * Create a Session object.
   *
   * @returns - A promise that resolves with a started session.
   */
  export function createSession(
    model: Session.IModel,
    settings?: ServerConnection.ISettings
  ): SessionConnection {
    settings = settings || ServerConnection.makeSettings();
    return new SessionConnection(
      {
        path: model.path,
        type: model.type,
        name: model.name,
        serverSettings: settings
      },
      model.id,
      model.kernel
    );
  }

  /**
   * Find a session by id.
   */
  export function findById(
    id: string,
    settings?: ServerConnection.ISettings
  ): Promise<Session.IModel> {
    settings = settings || ServerConnection.makeSettings();
    let running = runningSessions.get(settings.baseUrl) || [];
    let session = find(running, value => value.id === id);
    if (session) {
      return Promise.resolve(session.model);
    }

    return getSessionModel(id, settings).catch(() => {
      throw new Error(`No running session for id: ${id}`);
    });
  }

  /**
   * Find a session by path.
   */
  export function findByPath(
    path: string,
    settings?: ServerConnection.ISettings
  ): Promise<Session.IModel> {
    settings = settings || ServerConnection.makeSettings();
    let running = runningSessions.get(settings.baseUrl) || [];
    let session = find(running, value => value.path === path);
    if (session) {
      return Promise.resolve(session.model);
    }

    return listRunning(settings).then(models => {
      let model = find(models, value => {
        return value.path === path;
      });
      if (model) {
        return model;
      }
      throw new Error(`No running session for path: ${path}`);
    });
  }

  /**
   * Shut down all sessions.
   */
  export async function shutdownAll(
    settings?: ServerConnection.ISettings
  ): Promise<void> {
    settings = settings || ServerConnection.makeSettings();
    const running = await listRunning(settings);
    await Promise.all(running.map(s => shutdownSession(s.id, settings)));
  }

  /**
   * Start a new session.
   */
  export async function startNew(
    options: Session.IOptions
  ): Promise<Session.ISessionConnection> {
    if (options.path === undefined) {
      return Promise.reject(new Error('Must specify a path'));
    }
    let model = await restapi.startSession(options);
    return createSession(model, options.serverSettings);
  }

  /**
   * Update the running sessions given an updated session Id.
   */
  export function updateFromServer(
    model: Session.IModel,
    baseUrl: string
  ): Session.IModel {
    let running = runningSessions.get(baseUrl) || [];
    each(running.slice(), session => {
      if (session.id === model.id) {
        session.update(model);
      }
    });
    return model;
  }

  /**
   * Update the running sessions based on new data from the server.
   */
  export function updateRunningSessions(
    sessions: Session.IModel[],
    baseUrl: string
  ): Session.IModel[] {
    let running = runningSessions.get(baseUrl) || [];
    each(running.slice(), session => {
      let updated = find(sessions, sId => {
        if (session.id === sId.id) {
          session.update(sId);
          return true;
        }
        return false;
      });
      // If session is no longer running on disk, dispose the session.
      if (!updated && session.isDisposed !== true) {
        session.dispose();
      }
    });
    return sessions;
  }
}
