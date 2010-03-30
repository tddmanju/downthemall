/* ***** BEGIN LICENSE BLOCK *****
 * Version: MPL 1.1/GPL 2.0/LGPL 2.1
 *
 * The contents of this file are subject to the Mozilla Public License Version
 * 1.1 (the "License"); you may not use this file except in compliance with
 * the License. You may obtain a copy of the License at
 * http://www.mozilla.org/MPL/
 *
 * Software distributed under the License is distributed on an "AS IS" basis,
 * WITHOUT WARRANTY OF ANY KIND, either express or implied. See the License
 * for the specific language governing rights and limitations under the
 * License.
 *
 * The Original Code is DownThemAll! Verificator module
 *
 * The Initial Developer of the Original Code is Nils Maier
 * Portions created by the Initial Developer are Copyright (C) 2007
 * the Initial Developer. All Rights Reserved.
 *
 * Contributor(s):
 *	 Nils Maier <MaierMan@web.de>
 *
 * Alternatively, the contents of this file may be used under the terms of
 * either the GNU General Public License Version 2 or later (the "GPL"), or
 * the GNU Lesser General Public License Version 2.1 or later (the "LGPL"),
 * in which case the provisions of the GPL or the LGPL are applicable instead
 * of those above. If you wish to allow use of your version of this file only
 * under the terms of either the GPL or the LGPL, and not to allow others to
 * use your version of this file under the terms of the MPL, indicate your
 * decision by deleting the provisions above and replace them with the notice
 * and other provisions required by the GPL or the LGPL. If you do not delete
 * the provisions above, a recipient may use your version of this file under
 * the terms of any one of the MPL, the GPL or the LGPL.
 *
 * ***** END LICENSE BLOCK ***** */

const EXPORTED_SYMBOLS = ['verify'];

const PARTIAL_CHUNK = 1<<19; // power of two
const REGULAR_CHUNK = PARTIAL_CHUNK * 2; 

const Cc = Components.classes;
const Ci = Components.interfaces;
const Cr = Components.results;
const Cu = Components.utils;
const Ctor = Components.Constructor;
const module = Cu.import;
const Exception = Components.Exception;

const Prefs = {}, DTA = {};
module("resource://dta/preferences.jsm", Prefs);
module("resource://dta/utils.jsm");
module("resource://dta/api.jsm", DTA);

module("resource://gre/modules/XPCOMUtils.jsm");

ServiceGetter(this, "Debug", "@downthemall.net/debug-service;1", "dtaIDebugService");
ServiceGetter(this, "ThreadManager", "@mozilla.org/thread-manager;1", "nsIThreadManager");

const nsICryptoHash = Ci.nsICryptoHash;

const File = new Ctor('@mozilla.org/file/local;1', 'nsILocalFile', 'initWithPath');
const FileInputStream = new Ctor('@mozilla.org/network/file-input-stream;1', 'nsIFileInputStream', 'init');
const BinaryInputStream = new Ctor('@mozilla.org/binaryinputstream;1', 'nsIBinaryInputStream', 'setInputStream');
const Hash = new Ctor('@mozilla.org/security/hash;1', 'nsICryptoHash', 'init');

const _jobs = {};
function registerJob(obj) {
	let rv = newUUIDString();
	_jobs[rv] = obj;
	return rv;
}
function unregisterJob(job) {
	_jobs[job] = null;
	delete _jobs[job];
}

function verify(download, completeCallback, progressCallback){
	return new (download.hashCollection.hasPartials ? MultiVerificator : Verificator)(
		download.destinationFile,
		download.hashCollection,
		completeCallback,
		progressCallback
		);
}

function Callback(func, sync) {
	this._func = func;
	this._args = Array.map(arguments, function(e) e);
	this._args.shift();
	this._args.shift();
	this._thread = ThreadManager.mainThread;
	this._job = registerJob(this);
	this._thread.dispatch(this, sync ? 0x1 : 0x0);	
}
Callback.prototype = {
	QueryInterface: XPCOMUtils.generateQI([Ci.nsIRunnable]),
	run: function() {
		try {
			this._func.apply(this._func, this._args);
		}
		catch (ex) {
			Debug.log("Callback threw", ex);
		}
		unregisterJob(this._job);
	}
};

function Verificator(file, hashCollection, completeCallback, progressCallback) {
	this._file = file;
	this._hashCollection = hashCollection;
	this._completeCallback = completeCallback;
	this._progressCallback = progressCallback;
	
	this._job = registerJob(this._job);
	this._thread = ThreadManager.newThread(0);
	this._thread.dispatch(this, 0x0);
}
Verificator.prototype = {
	QueryInterface: XPCOMUtils.generateQI([Ci.nsIRunnable, Ci.nsICancelable]),
	terminated: false,
	_done: function(obj) {
		try {
			obj._thread.shutdown();
		}
		catch (ex) {
			// aborted before?!
		}
		unregisterJob(obj._job);
	},
	run: function() {
		let file = new File(this._file);
		let pending = file.fileSize;
		let completed = 0;
		let rv = true;
		let hashCollection = this._hashCollection;
		try {
			let mainHash = new Hash(nsICryptoHash[hashCollection.full.type]);
			let stream = new FileInputStream(file, 0x01, 0766, 0);
			try {
				while (pending) {
					if (this.terminated) {
						throw new Exception("terminated");
					}
					let count = Math.min(pending, 10485760);
					mainHash.updateFromStream(stream, count);
					pending -= count;
					completed += count;
					new Callback(this._progressCallback, false, completed);
				}
			}
			finally {
				stream.close();
			}
			let actual = hexdigest(mainHash.finish(false));
			new Callback(this._completeCallback, true, actual, hashCollection.full.sum);
		}
		catch (ex) {
			new Callback(this._completeCallback, true);
		}
		new Callback(this._done, false, this);
	},
	cancel: function() {
		this.terminated = true;
		try { this._thread.shutdown(); } catch (ex) { /* no op */ }
	}
};

function MultiVerificator() {
	Debug.logString("MultiVerificator");
	Verificator.apply(this, Array.map(arguments, function(e) e));
}
MultiVerificator.prototype = {
	__proto__: Verificator.prototype,
	run: function() {
		let file = new File(this._file);
		let pending = file.fileSize;
		let completed = 0;
		let rv = true;
		let hashCollection = this._hashCollection;
		try {
			let mainHash = new Hash(nsICryptoHash[hashCollection.full.type]);
			let stream = new FileInputStream(file, 0x01, 0766, 0);
			let bis = new BinaryInputStream(stream);
			try {
				for each (let partial in hashCollection.partials) {
					let pendingPartial = hashCollection.parLength;
					let partialHash = new Hash(nsICryptoHash[partial.type]);
					while (pendingPartial) {
						if (this.terminated) {
							throw new Exception("terminated");
						}
						let count = Math.min(pendingPartial, PARTIAL_CHUNK);
						
						// nsIStorageStream would be an alternative
						// doesn't implement writeFrom, however
						let bytes = bis.readByteArray(count);
						partialHash.update(bytes, bytes.length);
						mainHash.update(bytes, bytes.length);
						delete bytes;
						
						pending -= count;
						pendingPartial -= count;
						completed += count;
						new Callback(this._progressCallback, false, completed);						
					}
					let partialActual = hexdigest(partialHash.finish(false));
					delete partialHash;
					Components.utils.reportError("partial: " + partialActual);
				}
				
				// any remainder
				while (pending) {
					if (this.terminated) {
						throw new Exception("terminated");
					}
					let count = Math.min(pending, REGULAR_CHUNK);
					mainHash.updateFromStream(stream, count);
					pending -= count;
					completed += count;
					new Callback(this._progressCallback, false, completed);
				}
			}
			finally {
				stream.close();
				bis.close();
			}
			let actual = hexdigest(mainHash.finish(false));
			new Callback(this._completeCallback, true, actual, hashCollection.full.sum);
		}
		catch (ex) {
			Components.utils.reportError(ex);
			new Callback(this._completeCallback, true);
		}
		new Callback(this._done, false, this);
	}
};