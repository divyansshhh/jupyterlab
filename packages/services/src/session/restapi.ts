import { ServerConnection } from '../serverconnection';
import { Session } from '.';
import { URLExt } from '@jupyterlab/coreutils';
import { validateModel } from './validate';

/**
 * The url for the session service.
 */
export const SESSION_SERVICE_URL = 'api/sessions';

/**
 * List the running sessions.
 */
export async function listRunning(
  settings?: ServerConnection.ISettings
): Promise<Session.IModel[]> {
  settings = settings || ServerConnection.makeSettings();
  let url = URLExt.join(settings.baseUrl, SESSION_SERVICE_URL);
  let response = await ServerConnection.makeRequest(url, {}, settings);
  if (response.status !== 200) {
    throw new ServerConnection.ResponseError(response);
  }
  let data = await response.json();
  if (!Array.isArray(data)) {
    throw new Error('Invalid Session list');
  }
  for (let i = 0; i < data.length; i++) {
    data[i] = validateModel(data[i]);
  }

  return data;
}

/**
 * Get a session url.
 */
export function getSessionUrl(baseUrl: string, id: string): string {
  return URLExt.join(baseUrl, SESSION_SERVICE_URL, id);
}

/**
 * Shut down a session by id.
 */
export async function shutdownSession(
  id: string,
  settings: ServerConnection.ISettings = ServerConnection.makeSettings()
): Promise<void> {
  let url = getSessionUrl(settings.baseUrl, id);
  let init = { method: 'DELETE' };
  let response = await ServerConnection.makeRequest(url, init, settings);

  if (response.status === 404) {
    let data = await response.json();
    let msg =
      data.message || `The session "${id}"" does not exist on the server`;
    console.warn(msg);
  } else if (response.status === 410) {
    throw new ServerConnection.ResponseError(
      response,
      'The kernel was deleted but the session was not'
    );
  } else if (response.status !== 204) {
    throw new ServerConnection.ResponseError(response);
  }
}

/**
 * Get a full session model from the server by session id string.
 */
export async function getSessionModel(
  id: string,
  settings: ServerConnection.ISettings = ServerConnection.makeSettings()
): Promise<Session.IModel> {
  let url = getSessionUrl(settings.baseUrl, id);
  let response = await ServerConnection.makeRequest(url, {}, settings);
  if (response.status !== 200) {
    throw new ServerConnection.ResponseError(response);
  }
  let data = await response.json();
  validateModel(data);
  return data;
}

/**
 * Create a new session, or return an existing session if
 * the session path already exists
 */
export async function startSession(
  options: Session.IOptions
): Promise<Session.IModel> {
  let settings = options.serverSettings || ServerConnection.makeSettings();
  let model = {
    kernel: { name: options.kernelName, id: options.kernelId },
    path: options.path,
    type: options.type || '',
    name: options.name || ''
  };
  let url = URLExt.join(settings.baseUrl, SESSION_SERVICE_URL);
  let init = {
    method: 'POST',
    body: JSON.stringify(model)
  };
  let response = await ServerConnection.makeRequest(url, init, settings);
  if (response.status !== 201) {
    throw new ServerConnection.ResponseError(response);
  }
  let data = await response.json();
  validateModel(data);
  return data;
}

/**
 * Send a PATCH to the server, updating the session path or the kernel.
 */
export async function updateSession(
  id: string,
  body: string,
  settings: ServerConnection.ISettings = ServerConnection.makeSettings()
): Promise<Session.IModel> {
  let url = getSessionUrl(settings.baseUrl, id);
  let init = {
    method: 'PATCH',
    body
  };
  let response = await ServerConnection.makeRequest(url, init, settings);
  if (response.status !== 200) {
    throw new ServerConnection.ResponseError(response);
  }
  let data = await response.json();
  validateModel(data);
  return data;
}
