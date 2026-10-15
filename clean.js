//does the actual zip work. it runs in a web worker so the page doesn't freeze on big zips, but alt.js
//can also load it as a normal script if a worker can't start (e.g. when index.html is opened from file://)

//whole file or folder names to remove, and why (lowercase, because mac and windows names aren't case sensitive)
var hiddenNames = {
	//mac
	'__macosx': 'macOS resource forks',
	'.ds_store': 'macOS Finder settings',
	'.spotlight-v100': 'macOS Spotlight index',
	'.trashes': 'macOS Bin folder',
	'.fseventsd': 'macOS file system log',
	'.temporaryitems': 'macOS temporary files',
	'icon\r': 'macOS custom folder icon',
	//windows
	'thumbs.db': 'Windows thumbnail cache',
	'ehthumbs.db': 'Windows thumbnail cache',
	'ehthumbs_vista.db': 'Windows thumbnail cache',
	'desktop.ini': 'Windows folder settings',
	'$recycle.bin': 'Windows Recycle Bin',
	'system volume information': 'Windows system folder',
	//linux
	'.directory': 'KDE folder settings'
};

//gives the reason a file is hidden junk, or null if it should be kept
function hiddenReason(filename, file) {
	var parts = filename.split('/').filter(function(part) {
		return part !== '';
	});

	//check every part of the path, so things inside hidden folders get removed too
	for (var i = 0; i < parts.length; i++) {
		var part = parts[i].toLowerCase();
		if (Object.prototype.hasOwnProperty.call(hiddenNames, part)) {
			return hiddenNames[part];
		}
		//linux makes one of these per user on usb drives, like .Trash-1000
		if (/^\.trash-\d+$/.test(part)) {
			return 'Linux Bin folder';
		}
	}

	if (!file.dir) {
		var last = parts[parts.length - 1] || '';
		//mac makes these "AppleDouble" files when copying to usb drives and network shares
		if (last.indexOf('._') === 0) {
			return 'macOS resource fork';
		}
		//left behind when a file is deleted while still open on a network drive
		if (/^\.nfs[0-9a-f]{8,}$/i.test(last)) {
			return 'Linux network drive leftover';
		}
	}

	//windows hidden attribute, only set when the zip was made on windows
	//https://docs.microsoft.com/en-us/windows/desktop/fileio/file-attribute-constants (FILE_ATTRIBUTE_HIDDEN is 2)
	if (file.dosPermissions & 2) {
		return 'Hidden on Windows';
	}

	return null;
}

//works out the reason for every entry, including things inside folders that were hidden on windows
function findHidden(names, files) {
	var reasons = {};
	var hiddenFolders = [];

	names.forEach(function(name) {
		var reason = hiddenReason(name, files[name]);
		if (reason) {
			reasons[name] = reason;
			if (files[name].dir) {
				hiddenFolders.push(name);
			}
		}
	});

	names.forEach(function(name) {
		if (reasons[name]) {
			return;
		}
		for (var folder of hiddenFolders) {
			if (name.indexOf(folder) === 0) {
				reasons[name] = reasons[folder];
				break;
			}
		}
	});

	return reasons;
}

//names are meant to be flagged as utf-8 when they aren't plain english, but lots of tools don't bother, and jszip
//only calls this for the unflagged ones. try utf-8 first (mac and linux), then fall back to the old dos code page
//that windows' built-in zipping uses, so names like Résumé.docx don't come out garbled
var utf8 = new TextDecoder('utf-8', {fatal: true});
var cp437 = 'ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ ';

function decodeFileName(bytes) {
	bytes = new Uint8Array(bytes);
	try {
		return utf8.decode(bytes);
	} catch (error) {
		var name = '';
		for (var i = 0; i < bytes.length; i++) {
			name += bytes[i] < 128 ? String.fromCharCode(bytes[i]) : cp437[bytes[i] - 128];
		}
		return name;
	}
}

//resolves with {entries: [{name, reason}], blob}. blob is null when there was nothing to remove
function cleanZip(file, onProgress) {
	var zip = new JSZip();

	return zip.loadAsync(file, {decodeFileName: decodeFileName})
	.catch(function(error) {
		if (/encrypt/i.test(error.message)) {
			throw new Error('This zip is password protected, which isn\'t supported.');
		}
		throw new Error('Couldn\'t open this zip. It may be damaged, or not really a zip.');
	})
	.then(function() {
		var names = Object.keys(zip.files);
		var reasons = findHidden(names, zip.files);
		var entries = names.map(function(name) {
			return {name: name, reason: reasons[name] || null};
		});

		var hidden = names.filter(function(name) {
			return reasons[name];
		});
		if (hidden.length === 0) {
			return {entries: entries, blob: null};
		}

		//delete straight from the list, because zip.remove() on a folder looks through every entry each time
		hidden.forEach(function(name) {
			delete zip.files[name];
		});

		//keep unix permissions (like executable scripts) when the zip came from a mac or linux
		var unix = Object.keys(zip.files).some(function(name) {
			return zip.files[name].unixPermissions;
		});

		var lastPercent = -1;
		//DEFLATE keeps it compressed, and lets jszip copy already-compressed files across without redoing them
		return zip.generateAsync({
			type: 'blob',
			compression: 'DEFLATE',
			platform: unix ? 'UNIX' : 'DOS'
		}, function(metadata) {
			var percent = Math.floor(metadata.percent);
			if (percent !== lastPercent) {
				lastPercent = percent;
				onProgress(percent);
			}
		})
		.then(function(blob) {
			return {entries: entries, blob: blob};
		}, function() {
			throw new Error('Something went wrong while cleaning this zip.');
		});
	});
}

//when running as a worker, take jobs from alt.js
if (typeof importScripts === 'function') {
	importScripts('jszip.js');

	self.onmessage = function(e) {
		var id = e.data.id;
		cleanZip(e.data.file, function(percent) {
			self.postMessage({id: id, type: 'progress', percent: percent});
		})
		.then(function(result) {
			self.postMessage({id: id, type: 'done', entries: result.entries, blob: result.blob});
		}, function(error) {
			self.postMessage({id: id, type: 'error', message: error.message});
		});
	};
}
