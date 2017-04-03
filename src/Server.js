const JSONRPC = {};
JSONRPC.Exception = require("./Exception");
JSONRPC.IncomingRequest = require("./IncomingRequest");
JSONRPC.Utils = require("./Utils");
JSONRPC.EndpointBase = require("./EndpointBase");

const EventEmitter = require("events");


const assert = require("assert");

module.exports =
class Server extends EventEmitter
{
	constructor()
	{
		super();

		this._arrPlugins = [];
		this._objEndpoints = {};

		Object.seal(this);
	}


	/**
	 * It is assumed the httpServer is shared with outside code (other purposes).
	 * This JSONRPC.Server will only handle URLs under strRootPath.
	 * Specify "/" as root path to use the httpServer exclusively for a specific instance of this class.
	 * 
	 * Any request not under strRootPath will be completely ignored by this JSONRPC.Server.
	 * An outside handler is required for the ignored paths (or the default applies).
	 * 
	 * For paths under strRootPath which do not correspond to an endpoint, this JSONRPC.Server will respond with 404 and a JSONRPC valid error body.
	 * 
	 * Endpoint paths must fall under strRootPath or they will be ignored.
	 * 
	 * @param {http.Server} httpServer
	 * @param {string} strRootPath
	 */
	async attachToHTTPServer(httpServer, strRootPath)
	{
		assert(typeof strRootPath === "string", typeof strRootPath);

		strRootPath = JSONRPC.EndpointBase.normalizePath(strRootPath);

		httpServer.on(
			"request",
			async (httpRequest, httpResponse) => {
				const strRequestPath = JSONRPC.EndpointBase.normalizePath(httpRequest.url);

				// Ignore paths which do not fall under strRootPath, or are not strRootPath. 
				if(strRequestPath.substr(0, strRootPath.length) !== strRootPath)
				{
					// Do not call .end() here, or co-existing HTTP handlers on the same server will not have a chance to set headers or respond.
					// httpResponse.end();
					return;
				}

				try
				{
					// Default.
					httpResponse.statusCode = 500;

					const incomingRequest = await this.processHTTPRequest(httpRequest, httpResponse);
					await this.processRequest(incomingRequest);

					if(incomingRequest.callResult instanceof Error)
					{
						httpResponse.statusCode = 500; // Internal Server Error
					}
					else if(incomingRequest.isNotification)
					{
						httpResponse.statusCode = 204; // No Content
					}
					else
					{
						httpResponse.statusCode = 200; // Ok
					}
					

					if(incomingRequest.isNotification)
					{
						/*httpResponse.write(JSON.stringify({
							id: null,
							jsonrpc: "2.0",
							error: {
								message: "JSONRPC 2.0 notfications are not supported.",
								code: JSONRPC.Exception.INTERNAL_ERROR
							}
						}, undefined, "\t"));*/
					}
					else
					{
						httpResponse.setHeader("Content-Type", "application/json");
						httpResponse.write(incomingRequest.callResultSerialized);
					}
				}
				catch(error)
				{
					console.error(error);
				}

				httpResponse.end();
			}
		);
	}


	/**
	 * @param {EndpointBase} endpoint
	 */
	registerEndpoint(endpoint)
	{
		if(this._objEndpoints.hasOwnProperty(endpoint.path))
		{
			if(this._objEndpoints[endpoint.path] !== endpoint)
			{
				throw new Error("Another JSONRPC endpoint is registered at the same path: " + endpoint.path);
			}
			else
			{
				// Already added. Ignoring.
			}
		}
		else
		{
			this._objEndpoints[endpoint.path] = endpoint;
		}
	}


	/**
	 * Returns true if the endpoint was found and removed.
	 * Returns false if it was not found.
	 * 
	 * @param {string} strPath
	 * 
	 * @returns {boolean}
	 */
	unregisterEndpoint(strPath)
	{
		if(this._objEndpoints.hasOwnProperty(strPath))
		{
			delete this._objEndpoints[strPath];
			return true;
		}
	}


	/**
	 * @returns {Object}
	 */
	get endpoints()
	{
		return this._objEndpoints;
	}


	/**
	 * Adds a plugin.
	 * 
	 * @param {Object} plugin
	 */
	addPlugin(plugin)
	{
		if(this._arrPlugins.includes(plugin))
		{
			return;
		}

		this._arrPlugins.push(plugin);
	}


	/**
	 * Removes a plugin.
	 * 
	 * @param {Object} plugin
	 */
	removePlugin(plugin)
	{
		if(!this._arrPlugins.includes(plugin))
		{
			return;
		}

		this._arrPlugins.splice(
			this._arrPlugins.findIndex(
				(element) =>
				{
					return plugin === element;
				}
			), 
			1
		);
	}


	/**
	 * Code outside of this function is responsible for calling .end() on httpResponse.
	 * 
	 * @param {http.IncomingMessage} httpRequest
	 * @param {http.ServerResponse} httpResponse
	 * 
	 * @returns {JSONRPC.IncomingRequest}
	 */
	async processHTTPRequest(httpRequest, httpResponse)
	{
		const incomingRequest = new JSONRPC.IncomingRequest();

		try
		{
			if(httpRequest.method === "POST")
			{
				const arrBody = [];

				incomingRequest.requestBody = await new Promise(
					(fnResolve, fnReject) => {
						httpRequest.on("error",	fnReject);
						httpResponse.on("error", fnReject);

						httpRequest.on(
							"end",
							() => {
								fnResolve(Buffer.concat(arrBody).toString());
							}
						);

						httpRequest.on(
							"data", 
							(bufferChunk) => {
								arrBody.push(bufferChunk);
							}
						);
					}
				);
			}
			else
			{
				throw new Error("JSONRPC does not handle HTTP " + httpRequest.method + " requests.");
			}

			incomingRequest.headers = httpRequest.headers;
			incomingRequest.remoteAddress = httpRequest.socket.remoteAddress;

			const strPath = JSONRPC.EndpointBase.normalizePath(httpRequest.url);

			if(!this._objEndpoints.hasOwnProperty(strPath))
			{
				throw new JSONRPC.Exception("Unknown JSONRPC endpoint " + strPath + ".", JSONRPC.Exception.METHOD_NOT_FOUND);
			}
			incomingRequest.endpoint = this._objEndpoints[strPath];
		}
		catch(error)
		{
			incomingRequest.callResult = error;
		}

		return incomingRequest;
	}


	/**
	 * Returns the response object or null if in notification mode.
	 * 
	 * @param {JSONRPC.IncomingRequest} incomingRequest
	 * 
	 * @returns {null}
	 */
	async processRequest(incomingRequest)
	{
		try
		{
			if(!incomingRequest.isMethodCalled)
			{
				this.emit("beforeJSONDecode", incomingRequest);
				for(let plugin of this._arrPlugins)
				{
					await plugin.beforeJSONDecode(incomingRequest);
				}


				if(!incomingRequest.requestObject)
				{
					incomingRequest.requestObject = JSONRPC.Utils.jsonDecodeSafe(incomingRequest.requestBody);
				}

				this.emit("afterJSONDecode", incomingRequest);
				for(let plugin of this._arrPlugins)
				{
					await plugin.afterJSONDecode(incomingRequest);
				}


				if(Array.isArray(incomingRequest.requestObject))
				{
					throw new JSONRPC.Exception("Batch requests are not supported by this JSON-RPC server.", JSONRPC.Exception.INTERNAL_ERROR);
				}


				// JSON-RPC 2.0 Specification:
				// A Structured value that holds the parameter values to be used during the invocation of the method.
				// This member MAY be omitted.
				if(!incomingRequest.requestObject.hasOwnProperty("params"))
				{
					incomingRequest.requestObject.params = [];
				}
				else if(!Array.isArray(incomingRequest.requestObject.params))
				{
					if(typeof incomingRequest.requestObject.params === "object")
					{
						throw new JSONRPC.Exception("Named params are not supported by this server.", JSONRPC.Exception.INTERNAL_ERROR);
					}
					else
					{
						throw new JSONRPC.Exception("The params property has invalid data type, per JSON-RPC 2.0 specification. Unexpected type: " + (typeof incomingRequest.requestObject.params) + ".", JSONRPC.Exception.INVALID_REQUEST);
					}
				}


				if(!incomingRequest.isAuthenticated)
				{
					throw new JSONRPC.Exception("Not authenticated.", JSONRPC.Exception.NOT_AUTHENTICATED);
				}

				if(!incomingRequest.isAuthorized)
				{
					throw new JSONRPC.Exception("Not authorized.", JSONRPC.Exception.NOT_AUTHORIZED);
				}


				if(!incomingRequest.isMethodCalled)
				{
					this.emit("callFunction", incomingRequest);
				}
				for(let plugin of this._arrPlugins)
				{
					if(incomingRequest.isMethodCalled)
					{
						break;
					}

					// Allows plugins to override normal method calling on the exported endpoint.
					// If a plugin does choose to do this, all subsequent plugins will be skipped. 
					await plugin.callFunction(incomingRequest);
				}

				if(!incomingRequest.isMethodCalled)
				{
					if(typeof incomingRequest.endpoint[incomingRequest.requestObject.method] !== "function")
					{
						throw new JSONRPC.Exception("Method " + JSON.stringify(incomingRequest.requestObject.method) + " not found on endpoint " + JSON.stringify(incomingRequest.endpoint.path) + ".", JSONRPC.Exception.METHOD_NOT_FOUND);
					}

					incomingRequest.callResult = await incomingRequest.endpoint[incomingRequest.requestObject.method].apply(
						incomingRequest.endpoint, 
						[incomingRequest].concat(incomingRequest.requestObject.params)
					);
				}
			}
		}
		catch(error)
		{
			incomingRequest.callResult = error;
		}


		if(incomingRequest.callResult instanceof Error)
		{
			this.emit("exceptionCatch", incomingRequest);
			for(let plugin of this._arrPlugins)
			{
				await plugin.exceptionCatch(incomingRequest);
			}
		}
		else
		{
			this.emit("result", incomingRequest);
			for(let plugin of this._arrPlugins)
			{
				await plugin.result(incomingRequest);
			}
		}

		incomingRequest.callResultToBeSerialized = incomingRequest.toResponseObject();

		this.emit("response", incomingRequest);
		for(let plugin of this._arrPlugins)
		{
			await plugin.response(incomingRequest);
		}


		if(incomingRequest.callResultSerialized === null)
		{
			incomingRequest.callResultSerialized = JSON.stringify(incomingRequest.callResultToBeSerialized, undefined, "\t");
		}


		this.emit("afterSerialize", incomingRequest);
		for(let plugin of this._arrPlugins)
		{
			await plugin.afterSerialize(incomingRequest);
		}
	}
};
