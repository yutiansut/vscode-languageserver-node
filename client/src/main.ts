/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */
'use strict';

import * as cp from 'child_process';
import ChildProcess = cp.ChildProcess;

import { BaseLanguageClient, LanguageClientOptions, MessageTransports, StaticFeature, DynamicFeature } from './client';

import {
	workspace as Workspace, Disposable
} from 'vscode';

import {
	StreamMessageReader, StreamMessageWriter,
	IPCMessageReader, IPCMessageWriter,
	createClientPipeTransport, generateRandomPipeName, createClientSocketTransport
} from 'vscode-languageserver-protocol';

import * as Is from './utils/is';
import * as electron from './utils/electron';
import { terminate } from './utils/processes';

export * from './client';

declare var v8debug: any;

export interface ExecutableOptions {
	cwd?: string;
	stdio?: string | string[];
	env?: any;
	detached?: boolean;
}

export interface Executable {
	command: string;
	args?: string[];
	options?: ExecutableOptions;
}

export interface ForkOptions {
	cwd?: string;
	env?: any;
	encoding?: string;
	execArgv?: string[];
}

export enum TransportKind {
	stdio,
	ipc,
	pipe,
	socket
}

export interface SocketTransport {
	kind: TransportKind.socket;
	port: number;
}

namespace Transport {
	export function isSocket(value: Transport): value is SocketTransport {
		let candidate = value as SocketTransport;
		return candidate && candidate.kind === TransportKind.socket && Is.number(candidate.port);
	}
}

/**
 * To avoid any timing, pipe name or port number issues the pipe (TransportKind.pipe)
 * and the sockets (TransportKind.socket and SocketTransport) are owned by the
 * VS Code processes. The server process simply connects to the pipe / socket.
 * In node term the VS Code process calls `createServer`, then starts the server
 * process, waits until the server process has connected to the pipe / socket
 * and then signals that the connection has been established and messages can
 * be send back and forth. If the language server is implemented in a different
 * programm language the server simply needs to create a connection to the
 * passed pipe name or port number.
 */
export type Transport = TransportKind | SocketTransport;

export interface NodeModule {
	module: string;
	transport?: Transport;
	args?: string[];
	runtime?: string;
	options?: ForkOptions;
}

export interface StreamInfo {
	writer: NodeJS.WritableStream;
	reader: NodeJS.ReadableStream;
	detached?: boolean;
}

namespace StreamInfo {
	export function is(value: any): value is StreamInfo {
		let candidate = value as StreamInfo;
		return candidate && candidate.writer !== void 0 && candidate.reader !== void 0;
	}
}

export interface ChildProcessInfo {
	process: ChildProcess;
	detached: boolean;
}

namespace ChildProcessInfo {
	export function is(value: any): value is ChildProcessInfo {
		let candidate = value as ChildProcessInfo;
		return candidate && candidate.process !== void 0 && typeof candidate.detached === 'boolean';
	}
}

export type ServerOptions = Executable | { run: Executable; debug: Executable; } | { run: NodeModule; debug: NodeModule } | NodeModule | (() => Thenable<ChildProcess | StreamInfo | MessageTransports | ChildProcessInfo>);

export class LanguageClient extends BaseLanguageClient {

	private _serverOptions: ServerOptions;
	private _forceDebug: boolean;
	private _serverProcess: ChildProcess | undefined;
	private _isDetached: boolean | undefined;

	public constructor(name: string, serverOptions: ServerOptions, clientOptions: LanguageClientOptions, forceDebug?: boolean);
	public constructor(id: string, name: string, serverOptions: ServerOptions, clientOptions: LanguageClientOptions, forceDebug?: boolean);
	public constructor(arg1: string, arg2: ServerOptions | string, arg3: LanguageClientOptions | ServerOptions, arg4?: boolean | LanguageClientOptions, arg5?: boolean) {
		let id: string;
		let name: string;
		let serverOptions: ServerOptions;
		let clientOptions: LanguageClientOptions;
		let forceDebug: boolean;
		if (Is.string(arg2)) {
			id = arg1;
			name = arg2;
			serverOptions = arg3 as ServerOptions;
			clientOptions = arg4 as LanguageClientOptions;
			forceDebug = !!arg5;
		} else {
			id = arg1.toLowerCase();
			name = arg1;
			serverOptions = arg2 as ServerOptions;
			clientOptions = arg3 as LanguageClientOptions;
			forceDebug = arg4 as boolean;
		}
		if (forceDebug === void 0) { forceDebug = false; }
		super(id, name, clientOptions);
		this._serverOptions = serverOptions;
		this._forceDebug = forceDebug;
	}

	public stop(): Thenable<void> {
		return super.stop().then(() => {
			if (this._serverProcess) {
				let toCheck = this._serverProcess;
				this._serverProcess = undefined;
				if (this._isDetached === void 0 || !this._isDetached) {
					this.checkProcessDied(toCheck);
				}
				this._isDetached = undefined;
			}
		});
	}

	private checkProcessDied(childProcess: ChildProcess | undefined): void {
		if (!childProcess) {
			return;
		}
		setTimeout(() => {
			// Test if the process is still alive. Throws an exception if not
			try {
				process.kill(childProcess.pid, <any>0);
				terminate(childProcess);
			} catch (error) {
				// All is fine.
			}
		}, 2000);
	}

	protected handleConnectionClosed() {
		this._serverProcess = undefined;
		super.handleConnectionClosed();
	}


	protected createMessageTransports(encoding: string): Thenable<MessageTransports> {
		let rootPath = this.clientOptions.workspaceFolder
			? this.clientOptions.workspaceFolder.uri.fsPath
			: Workspace.rootPath;

		function getEnvironment(env: any): any {
			if (!env) {
				return process.env;
			}
			let result: any = Object.create(null);
			Object.keys(process.env).forEach(key => result[key] = process.env[key]);
			Object.keys(env).forEach(key => result[key] = env[key]);
			return result;
		}

		function startedInDebugMode(): boolean {
			let args: string[] = (process as any).execArgv;
			if (args) {
				return args.some((arg) => /^--debug=?/.test(arg) || /^--debug-brk=?/.test(arg) || /^--inspect=?/.test(arg) || /^--inspect-brk=?/.test(arg));
			};
			return false;
		}

		let server = this._serverOptions;
		// We got a function.
		if (Is.func(server)) {
			return server().then((result) => {
				if (MessageTransports.is(result)) {
					this._isDetached = !!result.detached;
					return result;
				} else if (StreamInfo.is(result)) {
					this._isDetached = !!result.detached;
					return { reader: new StreamMessageReader(result.reader), writer: new StreamMessageWriter(result.writer) };
				} else {
					let cp: ChildProcess;
					if (ChildProcessInfo.is(result)) {
						cp = result.process;
						this._isDetached = result.detached;
					} else {
						cp = result;
						this._isDetached = false;
					}
					cp.stderr.on('data', data => this.outputChannel.append(Is.string(data) ? data : data.toString(encoding)));
					return { reader: new StreamMessageReader(cp.stdout), writer: new StreamMessageWriter(cp.stdin) };
				}
			});
		}
		let json: { command?: string; module?: string };
		let runDebug = <{ run: any; debug: any; }>server;
		if (runDebug.run || runDebug.debug) {
			// We are under debugging. So use debug as well.
			if (typeof v8debug === 'object' || this._forceDebug || startedInDebugMode()) {
				json = runDebug.debug;
			} else {
				json = runDebug.run;
			}
		} else {
			json = server as NodeModule;
		}
		if (json.module) {
			let node: NodeModule = <NodeModule>json;
			let transport = node.transport || TransportKind.stdio;
			if (node.runtime) {
				let args: string[] = [];
				let options: ForkOptions = node.options || Object.create(null);
				if (options.execArgv) {
					options.execArgv.forEach(element => args.push(element));
				}
				args.push(node.module);
				if (node.args) {
					node.args.forEach(element => args.push(element));
				}
				let execOptions: ExecutableOptions = Object.create(null);
				execOptions.cwd = options.cwd || rootPath;
				execOptions.env = getEnvironment(options.env);
				let pipeName: string | undefined = undefined;
				if (transport === TransportKind.ipc) {
					// exec options not correctly typed in lib
					execOptions.stdio = <any>[null, null, null, 'ipc'];
					args.push('--node-ipc');
				} else if (transport === TransportKind.stdio) {
					args.push('--stdio');
				} else if (transport === TransportKind.pipe) {
					pipeName = generateRandomPipeName();
					args.push(`--pipe=${pipeName}`);
				} else if (Transport.isSocket(transport)) {
					args.push(`--socket=${transport.port}`);
				}
				args.push(`--clientProcessId=${process.pid.toString()}`);
				if (transport === TransportKind.ipc || transport === TransportKind.stdio) {
					let serverProcess = cp.spawn(node.runtime, args, execOptions);
					if (!serverProcess || !serverProcess.pid) {
						return Promise.reject<MessageTransports>(`Launching server using runtime ${node.runtime} failed.`);
					}
					this._serverProcess = serverProcess;
					serverProcess.stderr.on('data', data => this.outputChannel.append(Is.string(data) ? data : data.toString(encoding)));
					if (transport === TransportKind.ipc) {
						serverProcess.stdout.on('data', data => this.outputChannel.append(Is.string(data) ? data : data.toString(encoding)));
						return Promise.resolve({ reader: new IPCMessageReader(serverProcess), writer: new IPCMessageWriter(serverProcess) });
					} else {
						return Promise.resolve({ reader: new StreamMessageReader(serverProcess.stdout), writer: new StreamMessageWriter(serverProcess.stdin) });
					}
				} else if (transport == TransportKind.pipe) {
					return createClientPipeTransport(pipeName!).then((transport) => {
						let process = cp.spawn(node.runtime!, args, execOptions);
						if (!process || !process.pid) {
							return Promise.reject<MessageTransports>(`Launching server using runtime ${node.runtime} failed.`);
						}
						this._serverProcess = process;
						process.stderr.on('data', data => this.outputChannel.append(Is.string(data) ? data : data.toString(encoding)));
						process.stdout.on('data', data => this.outputChannel.append(Is.string(data) ? data : data.toString(encoding)));
						return transport.onConnected().then((protocol) => {
							return { reader: protocol[0], writer: protocol[1] };
						});
					})
				} else if (Transport.isSocket(transport)) {
					return createClientSocketTransport(transport.port).then((transport) => {
						let process = cp.spawn(node.runtime!, args, execOptions);
						if (!process || !process.pid) {
							return Promise.reject<MessageTransports>(`Launching server using runtime ${node.runtime} failed.`);
						}
						this._serverProcess = process;
						process.stderr.on('data', data => this.outputChannel.append(Is.string(data) ? data : data.toString(encoding)));
						process.stdout.on('data', data => this.outputChannel.append(Is.string(data) ? data : data.toString(encoding)));
						return transport.onConnected().then((protocol) => {
							return { reader: protocol[0], writer: protocol[1] };
						});
					});
				}
			} else {
				let pipeName: string | undefined = undefined;
				return new Promise<MessageTransports>((resolve, reject) => {
					let args = node.args && node.args.slice() || [];
					if (transport === TransportKind.ipc) {
						args.push('--node-ipc');
					} else if (transport === TransportKind.stdio) {
						args.push('--stdio');
					} else if (transport === TransportKind.pipe) {
						pipeName = generateRandomPipeName();
						args.push(`--pipe=${pipeName}`);
					} else if (Transport.isSocket(transport)) {
						args.push(`--socket=${transport.port}`);
					}
					args.push(`--clientProcessId=${process.pid.toString()}`);
					let options: ForkOptions = node.options || Object.create(null);
					options.execArgv = options.execArgv || [];
					options.cwd = options.cwd || rootPath;
					if (transport === TransportKind.ipc || transport === TransportKind.stdio) {
						electron.fork(node.module, args || [], options, (error, serverProcess) => {
							if (error || !serverProcess) {
								reject(error);
							} else {
								this._serverProcess = serverProcess;
								serverProcess.stderr.on('data', data => this.outputChannel.append(Is.string(data) ? data : data.toString(encoding)));
								if (transport === TransportKind.ipc) {
									serverProcess.stdout.on('data', data => this.outputChannel.append(Is.string(data) ? data : data.toString(encoding)));
									resolve({ reader: new IPCMessageReader(this._serverProcess), writer: new IPCMessageWriter(this._serverProcess) });
								} else {
									resolve({ reader: new StreamMessageReader(serverProcess.stdout), writer: new StreamMessageWriter(serverProcess.stdin) });
								}
							}
						});
					}  else if (transport === TransportKind.pipe) {
						createClientPipeTransport(pipeName!).then((transport) => {
							electron.fork(node.module, args || [], options, (error, cp) => {
								if (error || !cp) {
									reject(error);
								} else {
									this._serverProcess = cp;
									cp.stderr.on('data', data => this.outputChannel.append(Is.string(data) ? data : data.toString(encoding)));
									cp.stdout.on('data', data => this.outputChannel.append(Is.string(data) ? data : data.toString(encoding)));
									transport.onConnected().then((protocol) => {
										resolve({ reader: protocol[0], writer: protocol[1]});
									});
								}
							});
						});
					} else if (Transport.isSocket(transport)) {
						createClientSocketTransport(transport.port).then((transport) => {
							electron.fork(node.module, args || [], options, (error, cp) => {
								if (error || !cp) {
									reject(error);
								} else {
									this._serverProcess = cp;
									cp.stderr.on('data', data => this.outputChannel.append(Is.string(data) ? data : data.toString(encoding)));
									cp.stdout.on('data', data => this.outputChannel.append(Is.string(data) ? data : data.toString(encoding)));
									transport.onConnected().then((protocol) => {
										resolve({ reader: protocol[0], writer: protocol[1]});
									});
								}
							});
						});
					}
				});
			}
		} else if (json.command) {
			let command: Executable = <Executable>json;
			let args = command.args || [];
			let options = command.options || {};
			options.cwd = options.cwd || rootPath;
			let serverProcess = cp.spawn(command.command, args, options);
			if (!serverProcess || !serverProcess.pid) {
				return Promise.reject<MessageTransports>(`Launching server using command ${command.command} failed.`);
			}
			serverProcess.stderr.on('data', data => this.outputChannel.append(Is.string(data) ? data : data.toString(encoding)));
			this._serverProcess = serverProcess;
			this._isDetached = !!options.detached;
			return Promise.resolve({ reader: new StreamMessageReader(serverProcess.stdout), writer: new StreamMessageWriter(serverProcess.stdin) });
		}
		return Promise.reject<MessageTransports>(new Error(`Unsupported server configuration ` + JSON.stringify(server, null, 4)));
	}

	public registerProposedFeatures() {
		this.registerFeatures(ProposedFeatures.createAll(this));
	}
}

export class SettingMonitor {

	private _listeners: Disposable[];

	constructor(private _client: LanguageClient, private _setting: string) {
		this._listeners = [];
	}

	public start(): Disposable {
		Workspace.onDidChangeConfiguration(this.onDidChangeConfiguration, this, this._listeners);
		this.onDidChangeConfiguration();
		return new Disposable(() => {
			if (this._client.needsStop()) {
				this._client.stop();
			}
		});
	}

	private onDidChangeConfiguration(): void {
		let index = this._setting.indexOf('.');
		let primary = index >= 0 ? this._setting.substr(0, index) : this._setting;
		let rest = index >= 0 ? this._setting.substr(index + 1) : undefined;
		let enabled = rest ? Workspace.getConfiguration(primary).get(rest, false) : Workspace.getConfiguration(primary);
		if (enabled && this._client.needsStart()) {
			this._client.start();
		} else if (!enabled && this._client.needsStop()) {
			this._client.stop();
		}
	}
}

// Exporting proposed protocol.

import * as config from './configuration.proposed';
import * as folders from './workspaceFolders.proposed';

export namespace ProposedFeatures {
	export type ConfigurationFeature = config.ConfigurationFeature;
	export const ConfigurationFeature = config.ConfigurationFeature;
	export type ConfigurationMiddleware = config.ConfigurationMiddleware;

	export type WorkspaceFoldersFeature = folders.WorkspaceFoldersFeature;
	export const WorkspaceFoldersFeature = folders.WorkspaceFoldersFeature;
	export type WorkspaceFolderMiddleware = folders.WorkspaceFolderMiddleware

	export function createAll(client: BaseLanguageClient): (StaticFeature | DynamicFeature<any>)[] {
		let result: (StaticFeature | DynamicFeature<any>)[] = [];
		result.push(new WorkspaceFoldersFeature(client));
		result.push(new ConfigurationFeature(client));
		return result;
	}
}