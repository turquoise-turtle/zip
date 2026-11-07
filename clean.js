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
function hiddenReason(path, isDir, hiddenAttribute) {
	var parts = path.split('/').filter(function(part) {
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

	if (!isDir) {
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

	if (hiddenAttribute) {
		return 'Hidden on Windows';
	}

	return null;
}

//works out the reason for every entry, including things inside folders that were hidden on windows
function findHidden(entries) {
	var reasons = entries.map(function(entry) {
		return hiddenReason(entry.name, entry.dir, entry.hidden);
	});
	var hiddenFolders = entries.filter(function(entry, i) {
		return reasons[i] && entry.dir;
	});

	entries.forEach(function(entry, i) {
		if (reasons[i]) {
			return;
		}
		for (var folder of hiddenFolders) {
			if (entry.name.indexOf(folder.name) === 0) {
				reasons[i] = reasons[entries.indexOf(folder)];
				break;
			}
		}
	});

	return reasons;
}

//names are meant to be flagged as utf-8 when they aren't plain english, but lots of tools don't bother.
//try utf-8 first (mac and linux), then fall back to the old dos code page that windows' built-in zipping
//uses, so names like Résumé.docx show properly. names are only decoded for showing and checking, the
//cleaned zip keeps the original bytes
var utf8 = new TextDecoder('utf-8', {fatal: true});
var cp437 = 'ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ ';

function decodeFileName(bytes) {
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

//crc-32 "slicing by 8": eight lookup tables let it take 8 bytes per step instead of 1, which makes it about
//four times faster. that matters when zipping a big folder, because every byte has to go through it.
//table k (at k * 256) holds the crc of a byte followed by k zero bytes
var crcTables = new Uint32Array(8 * 256);
for (var n = 0; n < 256; n++) {
	var c = n;
	for (var k = 0; k < 8; k++) {
		c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
	}
	crcTables[n] = c;
}
for (var t = 256; t < 8 * 256; t++) {
	crcTables[t] = (crcTables[t - 256] >>> 8) ^ crcTables[crcTables[t - 256] & 0xFF];
}

//pass the previous result back in to carry on across chunks
function crc32(bytes, crc) {
	var T = crcTables;
	crc = ~(crc === undefined ? 0 : crc);
	var i = 0;
	var end8 = bytes.length - (bytes.length % 8);
	for (; i < end8; i += 8) {
		var lo = crc ^ (bytes[i] | (bytes[i + 1] << 8) | (bytes[i + 2] << 16) | (bytes[i + 3] << 24));
		crc = T[1792 + (lo & 0xFF)] ^ T[1536 + ((lo >>> 8) & 0xFF)] ^ T[1280 + ((lo >>> 16) & 0xFF)] ^ T[1024 + (lo >>> 24)] ^
			T[768 + bytes[i + 4]] ^ T[512 + bytes[i + 5]] ^ T[256 + bytes[i + 6]] ^ T[bytes[i + 7]];
	}
	for (; i < bytes.length; i++) {
		crc = T[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
	}
	return ~crc >>> 0;
}

//zip numbers are little-endian. 64-bit ones are fine as plain numbers up to 8 PB
function u16(bytes, at) {
	return bytes[at] | (bytes[at + 1] << 8);
}

function u32(bytes, at) {
	return (bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16)) + bytes[at + 3] * 0x1000000;
}

function u64(bytes, at) {
	return u32(bytes, at) + u32(bytes, at + 4) * 0x100000000;
}

function set16(bytes, at, value) {
	bytes[at] = value & 0xFF;
	bytes[at + 1] = (value >>> 8) & 0xFF;
}

function set32(bytes, at, value) {
	set16(bytes, at, value & 0xFFFF);
	set16(bytes, at + 2, Math.floor(value / 0x10000) & 0xFFFF);
}

function set64(bytes, at, value) {
	set32(bytes, at, value % 0x100000000);
	set32(bytes, at + 4, Math.floor(value / 0x100000000));
}

var DAMAGED = 'Couldn\'t open this zip. It may be damaged, or not really a zip.';
var SPLIT = 'This zip is split into parts, which isn\'t supported.';

//only reads the bytes it needs, so even huge zips never have to fit in memory
function read(file, start, end) {
	return file.slice(start, end).arrayBuffer().then(function(buffer) {
		return new Uint8Array(buffer);
	});
}

//these systems keep windows-style attributes (like hidden) in the low byte of a zip entry's attributes
var dosHosts = {0: true, 6: true, 10: true, 11: true, 14: true};

//reads the central directory, the list at the end of a zip of where every entry is
function readZip(file) {
	if (file.size < 22) {
		return Promise.reject(new Error(DAMAGED));
	}
	//the end record is 22 bytes plus a comment of up to 65,535 bytes, with a 20-byte zip64 locator before it
	var tailStart = Math.max(0, file.size - 22 - 0xFFFF - 20);
	return read(file, tailStart, file.size).then(function(tail) {
		var at = -1;
		for (var i = tail.length - 22; i >= 0; i--) {
			if (u32(tail, i) === 0x06054B50 && i + 22 + u16(tail, i + 20) <= tail.length) {
				at = i;
				break;
			}
		}
		if (at === -1) {
			throw new Error(DAMAGED);
		}

		var zip = {
			file: file,
			eocdAt: tailStart + at,
			eocd: tail.slice(at, at + 22 + u16(tail, at + 20)),
			count: u16(tail, at + 10),
			cdSize: u32(tail, at + 12),
			cdOffset: u32(tail, at + 16)
		};
		if ((u16(tail, at + 4) !== 0 && u16(tail, at + 4) !== 0xFFFF) || (u16(tail, at + 6) !== 0 && u16(tail, at + 6) !== 0xFFFF)) {
			throw new Error(SPLIT);
		}

		if (at >= 20 && u32(tail, at - 20) === 0x07064B50) {
			if (u32(tail, at - 4) > 1) {
				throw new Error(SPLIT);
			}
			return readZip64End(zip, u64(tail, at - 12));
		}
		return zip;
	})
	.then(function(zip) {
		var cdEnd = zip.zip64At === undefined ? zip.eocdAt : zip.zip64At;
		zip.cdStart = cdEnd - zip.cdSize;
		//self-extracting zips have a program in front, and their offsets often don't count it
		zip.shift = zip.cdStart - zip.cdOffset;
		if (zip.cdStart < 0 || zip.shift < 0) {
			throw new Error(DAMAGED);
		}
		return read(file, zip.cdStart, cdEnd).then(function(cd) {
			zip.entries = readEntries(zip, cd);
			return zip;
		});
	});
}

//the zip64 end record always ends right where its locator starts. it's normally where the locator says,
//but with data in front of the zip it's only findable by that, so try both
function readZip64End(zip, recordedAt) {
	var end = zip.eocdAt - 20;
	function tryAt(start) {
		if (start < 0 || start + 56 > end) {
			return Promise.resolve(null);
		}
		return read(zip.file, start, end).then(function(bytes) {
			return u32(bytes, 0) === 0x06064B50 && start + 12 + u64(bytes, 4) === end ? bytes : null;
		});
	}
	return tryAt(recordedAt).then(function(bytes) {
		return bytes ? [recordedAt, bytes] : tryAt(end - 56).then(function(bytes) {
			return [end - 56, bytes];
		});
	}).then(function(found) {
		var bytes = found[1];
		if (!bytes) {
			throw new Error(DAMAGED);
		}
		if (u32(bytes, 16) !== 0 || u32(bytes, 20) !== 0) {
			throw new Error(SPLIT);
		}
		zip.zip64At = found[0];
		zip.zip64 = bytes;
		zip.count = u64(bytes, 32);
		zip.cdSize = u64(bytes, 40);
		zip.cdOffset = u64(bytes, 48);
		return zip;
	});
}

var utf8Loose = new TextDecoder('utf-8');

function readEntries(zip, cd) {
	var entries = [];
	var at = 0;
	while (at < cd.length) {
		if (at + 46 > cd.length || u32(cd, at) !== 0x02014B50) {
			throw new Error(DAMAGED);
		}
		var nameLength = u16(cd, at + 28);
		var extraLength = u16(cd, at + 30);
		var length = 46 + nameLength + extraLength + u16(cd, at + 32);
		if (at + length > cd.length) {
			throw new Error(DAMAGED);
		}
		var record = cd.slice(at, at + length);
		var rawName = record.subarray(46, 46 + nameLength);
		var entry = {
			record: record,
			offset: u32(record, 42),
			//where the offset lives in the record, so it can be updated later
			offsetAt: 42,
			offsetSize: 4
		};
		var name = null;

		var e = 46 + nameLength;
		var extraEnd = e + extraLength;
		while (e + 4 <= extraEnd) {
			var tag = u16(record, e);
			var size = u16(record, e + 2);
			var value = e + 4;
			if (tag === 0x0001) {
				//zip64 sizes and offset, but only for the fields that were too big to fit
				if (u32(record, 24) === 0xFFFFFFFF) {
					value += 8;
				}
				if (u32(record, 20) === 0xFFFFFFFF) {
					value += 8;
				}
				if (entry.offset === 0xFFFFFFFF && value + 8 <= e + 4 + size) {
					entry.offset = u64(record, value);
					entry.offsetAt = value;
					entry.offsetSize = 8;
				}
			} else if (tag === 0x7075 && size > 5 && record[value] === 1 && u32(record, value + 1) === crc32(rawName)) {
				//info-zip's unicode name, for zips whose main name isn't utf-8
				name = utf8Loose.decode(record.subarray(value + 5, e + 4 + size));
			}
			e += 4 + size;
		}

		if (u16(record, 8) & 0x800) {
			name = utf8Loose.decode(rawName);
		} else if (name === null) {
			name = decodeFileName(rawName);
		}
		entry.name = name;
		var attributes = dosHosts[record[5]] ? record[38] : 0;
		entry.dir = /\/$/.test(name) || (attributes & 0x10) !== 0;
		entry.hidden = (attributes & 0x02) !== 0;
		entry.localAt = entry.offset + zip.shift;
		if (entry.localAt >= zip.cdStart) {
			throw new Error(DAMAGED);
		}
		entries.push(entry);
		at += length;
	}
	//the entry count isn't checked: some tools get it wrong, and the central directory's size is what matters
	return entries;
}

//makes sure each kept entry really starts where the central directory says, so a damaged zip can't
//quietly turn into a broken copy
function checkLocalHeaders(file, starts) {
	//reading every header on its own is very slow with tens of thousands of entries, so headers that are
	//close together (within 1 MB) are read in one go
	var groups = [];
	starts.forEach(function(start) {
		var group = groups[groups.length - 1];
		if (group && start - group[0] < 0x100000) {
			group.push(start);
		} else {
			groups.push([start]);
		}
	});
	var checked = Promise.resolve();
	groups.forEach(function(group) {
		checked = checked.then(function() {
			var from = group[0];
			return read(file, from, group[group.length - 1] + 4).then(function(bytes) {
				group.forEach(function(start) {
					if (start - from + 4 > bytes.length || u32(bytes, start - from) !== 0x04034B50) {
						throw new Error(DAMAGED);
					}
				});
			});
		});
	});
	return checked;
}

//resolves with {entries: [{name, reason}], blob}. blob is null when there was nothing to remove.
//kept entries are copied byte for byte (local header, data and any data descriptor) as slices of the
//original file, and only the central directory is rewritten with their new positions. so nothing is
//decompressed, and names, dates, permissions, comments and even passwords stay exactly as they were
function cleanZip(file) {
	return readZip(file).then(function(zip) {
		var reasons = findHidden(zip.entries);
		var list = zip.entries.map(function(entry, i) {
			return {name: entry.name, reason: reasons[i]};
		});
		var kept = zip.entries.filter(function(entry, i) {
			return !reasons[i];
		});
		if (kept.length === zip.entries.length) {
			return {entries: list, blob: null};
		}

		//each entry runs from its local header to wherever the next one (or the central directory) starts,
		//which also takes in its data descriptor without having to work out how long that is
		var starts = zip.entries.map(function(entry) {
			return entry.localAt;
		}).sort(function(a, b) {
			return a - b;
		}).filter(function(start, i, all) {
			return i === 0 || start !== all[i - 1];
		});
		var ends = {};
		starts.forEach(function(start, i) {
			ends[start] = i + 1 < starts.length ? starts[i + 1] : zip.cdStart;
		});
		var keptAt = new Set(kept.map(function(entry) {
			return entry.localAt;
		}));
		var keptStarts = starts.filter(function(start) {
			return keptAt.has(start);
		});

		return checkLocalHeaders(file, keptStarts).then(function() {
			//entries that sit next to each other are copied as one slice, because a blob made of tens of
			//thousands of pieces is very slow to build and download
			var parts = [];
			var moved = {};
			var position = 0;
			var runStart = null;
			keptStarts.forEach(function(start, i) {
				if (runStart === null) {
					runStart = start;
				}
				moved[start] = position;
				position += ends[start] - start;
				if (i + 1 === keptStarts.length || keptStarts[i + 1] !== ends[start]) {
					parts.push(file.slice(runStart, ends[start]));
					runStart = null;
				}
			});

			var cdStart = position;
			var cd = new Uint8Array(kept.reduce(function(total, entry) {
				return total + entry.record.length;
			}, 0));
			var at = 0;
			kept.forEach(function(entry) {
				cd.set(entry.record, at);
				//only ever smaller than before, so it always fits where the old offset was
				if (entry.offsetSize === 8) {
					set64(cd, at + entry.offsetAt, moved[entry.localAt]);
				} else {
					set32(cd, at + entry.offsetAt, moved[entry.localAt]);
				}
				at += entry.record.length;
			});
			parts.push(cd);
			position += cd.length;
			var cdSize = cd.length;

			if (zip.zip64) {
				var zip64 = zip.zip64.slice();
				set64(zip64, 24, kept.length);
				set64(zip64, 32, kept.length);
				set64(zip64, 40, cdSize);
				set64(zip64, 48, cdStart);
				var locator = new Uint8Array(20);
				set32(locator, 0, 0x07064B50);
				set64(locator, 8, position);
				set32(locator, 16, 1);
				parts.push(zip64, locator);
			}
			//numbers too big for the classic end record are left as "see zip64" markers
			var eocd = zip.eocd.slice();
			if (u16(eocd, 8) !== 0xFFFF) {
				set16(eocd, 8, kept.length);
				set16(eocd, 10, kept.length);
			}
			if (u32(eocd, 12) !== 0xFFFFFFFF) {
				set32(eocd, 12, cdSize);
			}
			if (u32(eocd, 16) !== 0xFFFFFFFF) {
				set32(eocd, 16, cdStart);
			}
			parts.push(eocd);

			return {entries: list, blob: new Blob(parts, {type: 'application/zip'})};
		});
	}, function(error) {
		throw error.message === SPLIT ? error : new Error(DAMAGED);
	});
}

//files that are already compressed, so squeezing them again only costs time
var alreadyCompressed = /\.(zip|7z|rar|gz|tgz|bz2|xz|zst|jpe?g|png|gif|webp|heic|heif|avif|mp3|m4a|aac|ogg|opus|flac|mp4|m4v|mov|avi|mkv|webm|pdf|docx|xlsx|pptx|odt|ods|odp|epub|jar|apk|dmg|woff2?)$/i;
//bigger files are stored as they are, so the zip never has to hold a huge compressed copy in memory
var compressLimit = 256 * 1024 * 1024;
var chunkSize = 8 * 1024 * 1024;
//big files go in the zip as references to the original file, so they're never copied into memory. but
//some browsers can only read so many files into one blob (Safari manages about 2,000), and a download
//that goes past that just fails. so a quick probe first reads 1 byte from each of them as one blob, which
//fails at the same point the real thing would. files that don't fit go in as the bytes read for their
//checksum instead
var referenceOver = 1024 * 1024;

function canRead(files) {
	return new Blob(files.map(function(file) {
		return file.slice(0, 1);
	})).arrayBuffer().then(function() {
		return true;
	}, function() {
		return false;
	});
}

//resolves with how many of the files can go in as references: all of them if the probe passes, otherwise
//the first of 1,000, 500, 250 and so on that does
function referenceLimit(files) {
	function attempt(count) {
		if (count === 0) {
			return Promise.resolve(0);
		}
		return canRead(files.slice(0, count)).then(function(ok) {
			if (ok) {
				return count;
			}
			return attempt(count > 1000 ? 1000 : Math.floor(count / 2));
		});
	}
	return attempt(files.length);
}

//collects the pieces of a zip. a blob made of tens of thousands of pieces is very slow to build and
//download, so runs of small pieces are joined into blocks of about 4 MB
function Pieces() {
	this.parts = [];
	this.pending = [];
	this.pendingSize = 0;
}

Pieces.prototype.add = function(piece) {
	if (piece instanceof Blob) {
		this.flush();
		this.parts.push(piece);
		return;
	}
	this.pending.push(piece);
	this.pendingSize += piece.length;
	if (this.pendingSize >= 4 * 1024 * 1024) {
		this.flush();
	}
};

Pieces.prototype.flush = function() {
	if (!this.pending.length) {
		return;
	}
	var block = new Uint8Array(this.pendingSize);
	var at = 0;
	this.pending.forEach(function(piece) {
		block.set(piece, at);
		at += piece.length;
	});
	this.parts.push(block);
	this.pending = [];
	this.pendingSize = 0;
};

Pieces.prototype.blob = function() {
	this.flush();
	return new Blob(this.parts, {type: 'application/zip'});
};

//compressing needs CompressionStream with raw deflate (Chrome 103, Firefox 113, Safari 16.4). without it
//everything is stored uncompressed, which is still a perfectly good zip
function canCompress() {
	try {
		new CompressionStream('deflate-raw');
		return true;
	} catch (error) {
		return false;
	}
}

//reads a file in chunks, so even huge files never have to fit in memory
function eachChunk(file, onChunk) {
	var at = 0;
	function next() {
		if (at >= file.size) {
			return Promise.resolve();
		}
		var end = Math.min(at + chunkSize, file.size);
		return read(file, at, end).then(function(bytes) {
			at = end;
			return Promise.resolve(onChunk(bytes)).then(next);
		});
	}
	return next();
}

//resolves with {crc, size, method, data, dataSize}, where data is what goes after the local header.
//byReference puts the file itself in the zip rather than its bytes
function prepareFile(file, compress, byReference, onBytes) {
	var crc = 0;
	var original = [];
	function readChunk(bytes) {
		crc = crc32(bytes, crc);
		onBytes(bytes.length);
		if (!byReference) {
			original.push(bytes);
		}
	}
	function stored() {
		return {crc: crc, size: file.size, method: 0, data: byReference ? [file] : original, dataSize: file.size};
	}
	if (!compress) {
		return eachChunk(file, readChunk).then(stored);
	}
	var stream = new CompressionStream('deflate-raw');
	var writer = stream.writable.getWriter();
	var reader = stream.readable.getReader();
	var chunks = [];
	var dataSize = 0;
	var collected = (function collect() {
		return reader.read().then(function(result) {
			if (result.done) {
				return;
			}
			chunks.push(result.value);
			dataSize += result.value.length;
			return collect();
		});
	})();
	return eachChunk(file, function(bytes) {
		readChunk(bytes);
		return writer.write(bytes);
	}).then(function() {
		return writer.close();
	}).then(function() {
		return collected;
	}).then(function() {
		//some files don't get any smaller, so keep those as they are
		if (dataSize >= file.size) {
			return stored();
		}
		return {crc: crc, size: file.size, method: 8, data: chunks, dataSize: dataSize};
	});
}

//zip dates are local time in 2-second steps, starting from 1980
function dosDateTime(time) {
	var date = new Date(time);
	if (date.getFullYear() < 1980) {
		return {time: 0, date: (1 << 5) | 1};
	}
	return {
		time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
		date: ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()
	};
}

var utf8Encoder = new TextEncoder();

//where a folder zip goes. BlobOutput builds it up as a blob (big files as references to themselves).
//StreamOutput sends it through a MessagePort to the service worker, which hands it to the browser as a
//download while it's still being made, so nothing piles up in memory however big the folder is
function BlobOutput() {
	this.pieces = new Pieces();
}

BlobOutput.prototype.write = function(piece) {
	this.pieces.add(piece);
	return Promise.resolve();
};

BlobOutput.prototype.finish = function() {
	return Promise.resolve(this.pieces.blob());
};

//the service worker asks for each piece ('pull') when the download is ready for more, so a slow disk or
//network can't make pieces pile up. small pieces are gathered into messages of about 1 MB
function StreamOutput(port) {
	var output = this;
	this.port = port;
	this.size = 0;
	this.credits = 0;
	this.cancelled = false;
	this.waiting = null;
	this.pending = new Pieces();
	port.onmessage = function(e) {
		var waiting = output.waiting;
		output.waiting = null;
		if (e.data === 'pull') {
			output.credits++;
			if (waiting) {
				waiting.resume();
			}
		} else if (e.data === 'cancelled') {
			//cancelled in the browser's downloads, so stop making it
			output.cancelled = true;
			if (waiting) {
				waiting.stop(new Error('The download was cancelled.'));
			}
		}
	};
}

StreamOutput.prototype.write = function(piece) {
	this.pending.add(piece);
	if (this.pending.pendingSize < 1024 * 1024) {
		return Promise.resolve();
	}
	return this.send();
};

StreamOutput.prototype.send = function() {
	var output = this;
	this.pending.flush();
	var blocks = this.pending.parts;
	this.pending.parts = [];
	return blocks.reduce(function(previous, block) {
		return previous.then(function() {
			return output.credit();
		}).then(function() {
			output.credits--;
			output.size += block.length;
			output.port.postMessage(block, [block.buffer]);
		});
	}, Promise.resolve());
};

StreamOutput.prototype.credit = function() {
	var output = this;
	if (this.cancelled) {
		return Promise.reject(new Error('The download was cancelled.'));
	}
	if (this.credits > 0) {
		return Promise.resolve();
	}
	return new Promise(function(resolve, reject) {
		output.waiting = {resume: resolve, stop: reject};
	});
};

StreamOutput.prototype.finish = function() {
	var output = this;
	return this.send().then(function() {
		output.port.postMessage('end');
		return null;
	});
};

StreamOutput.prototype.fail = function(message) {
	//makes the browser mark the download as failed, rather than leaving a broken zip
	this.port.postMessage({error: message});
};

//reads a file once, sending its data straight on (compressed or not) while working out its checksum,
//for zips that are streamed and so can't go back to fill in the header
function streamFile(file, compress, output, onBytes) {
	var crc = 0;
	var dataSize = 0;
	if (!compress) {
		return eachChunk(file, function(bytes) {
			crc = crc32(bytes, crc);
			onBytes(bytes.length);
			dataSize += bytes.length;
			return output.write(bytes);
		}).then(function() {
			return {crc: crc, size: file.size, method: 0, dataSize: dataSize};
		});
	}
	var stream = new CompressionStream('deflate-raw');
	var writer = stream.writable.getWriter();
	var reader = stream.readable.getReader();
	var sent = (function send() {
		return reader.read().then(function(result) {
			if (result.done) {
				return;
			}
			dataSize += result.value.length;
			return output.write(result.value).then(send);
		});
	})();
	return eachChunk(file, function(bytes) {
		crc = crc32(bytes, crc);
		onBytes(bytes.length);
		return writer.write(bytes);
	}).then(function() {
		return writer.close();
	}).then(function() {
		return sent;
	}).then(function() {
		return {crc: crc, size: file.size, method: 8, dataSize: dataSize};
	});
}

//extended timestamp, so unzipping gets the exact time in any time zone
function timestampField(time) {
	var timestamp = new Uint8Array(9);
	set16(timestamp, 0, 0x5455);
	set16(timestamp, 2, 5);
	timestamp[4] = 1;
	set32(timestamp, 5, Math.max(0, Math.min(Math.floor(time / 1000), 0xFFFFFFFF)));
	return timestamp;
}

//a streamed entry's sizes aren't known until after its data, so they go in a data descriptor that follows
//it (bit 3 of the flags). zip64 has to be decided up front, so files close to 4 GB get it to be safe
function localHeader(c) {
	var extra = c.timestamp;
	if (c.zip64) {
		extra = new Uint8Array(c.timestamp.length + 20);
		extra.set(c.timestamp);
		set16(extra, c.timestamp.length, 0x0001);
		set16(extra, c.timestamp.length + 2, 16);
		set64(extra, c.timestamp.length + 4, c.streamed ? 0 : c.size);
		set64(extra, c.timestamp.length + 12, c.streamed ? 0 : c.dataSize);
	}
	var local = new Uint8Array(30 + c.name.length + extra.length);
	set32(local, 0, 0x04034B50);
	set16(local, 4, c.zip64 ? 45 : 20);
	//names are utf-8
	set16(local, 6, c.streamed ? 0x808 : 0x800);
	set16(local, 8, c.method);
	set16(local, 10, c.when.time);
	set16(local, 12, c.when.date);
	if (!c.streamed) {
		set32(local, 14, c.crc);
		set32(local, 18, c.zip64 ? 0xFFFFFFFF : c.dataSize);
		set32(local, 22, c.zip64 ? 0xFFFFFFFF : c.size);
	} else if (c.zip64) {
		set32(local, 18, 0xFFFFFFFF);
		set32(local, 22, 0xFFFFFFFF);
	}
	set16(local, 26, c.name.length);
	set16(local, 28, extra.length);
	local.set(c.name, 30);
	local.set(extra, 30 + c.name.length);
	return local;
}

function dataDescriptor(c) {
	var descriptor = new Uint8Array(c.zip64 ? 24 : 16);
	set32(descriptor, 0, 0x08074B50);
	set32(descriptor, 4, c.crc);
	if (c.zip64) {
		set64(descriptor, 8, c.dataSize);
		set64(descriptor, 16, c.size);
	} else {
		set32(descriptor, 8, c.dataSize);
		set32(descriptor, 12, c.size);
	}
	return descriptor;
}

//the central directory and end records, for entries described by localHeader's c
function zipEnd(central, cdStart) {
	var records = central.map(function(c) {
		//zip64 fields are only there for the numbers too big to fit
		var zip64 = [];
		if (c.size >= 0xFFFFFFFF) {
			zip64.push(c.size);
		}
		if (c.dataSize >= 0xFFFFFFFF) {
			zip64.push(c.dataSize);
		}
		if (c.offset >= 0xFFFFFFFF) {
			zip64.push(c.offset);
		}
		var extra = new Uint8Array(c.timestamp.length + (zip64.length ? 4 + zip64.length * 8 : 0));
		extra.set(c.timestamp);
		if (zip64.length) {
			set16(extra, c.timestamp.length, 0x0001);
			set16(extra, c.timestamp.length + 2, zip64.length * 8);
			zip64.forEach(function(value, i) {
				set64(extra, c.timestamp.length + 4 + i * 8, value);
			});
		}
		var version = zip64.length || c.zip64 ? 45 : 20;
		var record = new Uint8Array(46 + c.name.length + extra.length);
		set32(record, 0, 0x02014B50);
		//made on unix, so the permissions below are read
		set16(record, 4, (3 << 8) | version);
		set16(record, 6, version);
		set16(record, 8, c.streamed ? 0x808 : 0x800);
		set16(record, 10, c.method);
		set16(record, 12, c.when.time);
		set16(record, 14, c.when.date);
		set32(record, 16, c.crc);
		set32(record, 20, c.dataSize >= 0xFFFFFFFF ? 0xFFFFFFFF : c.dataSize);
		set32(record, 24, c.size >= 0xFFFFFFFF ? 0xFFFFFFFF : c.size);
		set16(record, 28, c.name.length);
		set16(record, 30, extra.length);
		//rw-r--r-- for files and rwxr-xr-x for folders, since browsers can't see the real permissions
		set32(record, 38, c.isFile ? 0x81A40000 : 0x41ED0010);
		set32(record, 42, c.offset >= 0xFFFFFFFF ? 0xFFFFFFFF : c.offset);
		record.set(c.name, 46);
		record.set(extra, 46 + c.name.length);
		return record;
	});
	var cdSize = records.reduce(function(sum, record) {
		return sum + record.length;
	}, 0);
	var cd = new Uint8Array(cdSize);
	var at = 0;
	records.forEach(function(record) {
		cd.set(record, at);
		at += record.length;
	});
	var parts = [cd];
	
	var count = records.length;
	if (count >= 0xFFFF || cdSize >= 0xFFFFFFFF || cdStart >= 0xFFFFFFFF) {
		var zip64End = new Uint8Array(56);
		set32(zip64End, 0, 0x06064B50);
		set64(zip64End, 4, 44);
		set16(zip64End, 12, (3 << 8) | 45);
		set16(zip64End, 14, 45);
		set64(zip64End, 24, count);
		set64(zip64End, 32, count);
		set64(zip64End, 40, cdSize);
		set64(zip64End, 48, cdStart);
		var locator = new Uint8Array(20);
		set32(locator, 0, 0x07064B50);
		set64(locator, 8, cdStart + cdSize);
		set32(locator, 16, 1);
		parts.push(zip64End, locator);
	}
	var end = new Uint8Array(22);
	set32(end, 0, 0x06054B50);
	set16(end, 8, Math.min(count, 0xFFFF));
	set16(end, 10, Math.min(count, 0xFFFF));
	set32(end, 12, Math.min(cdSize, 0xFFFFFFFF));
	set32(end, 16, Math.min(cdStart, 0xFFFFFFFF));
	parts.push(end);
	return parts;
}

//builds a zip from a folder's files, leaving out the hidden junk. items are {path, file}, with file null
//for an empty folder. with a port the zip is streamed to the service worker (see StreamOutput), otherwise
//it's built as a blob. resolves with {entries: [{name, reason}], blob}, where blob is null if everything
//was junk or the zip was streamed
function zipFolder(items, onProgress, port) {
	var reasons = findHidden(items.map(function(item) {
		return {name: item.path, dir: !item.file, hidden: false};
	}));
	var list = items.map(function(item, i) {
		return {name: item.path, reason: reasons[i]};
	});
	var kept = items.filter(function(item, i) {
		return !reasons[i];
	});
	if (!kept.some(function(item) {
		return item.file;
	})) {
		if (port) {
			port.postMessage({error: 'Nothing to zip'});
		}
		return Promise.resolve({entries: list, blob: null});
	}
	
	var output = port ? new StreamOutput(port) : new BlobOutput();
	var compress = canCompress();
	var total = kept.reduce(function(sum, item) {
		return sum + (item.file ? item.file.size : 0);
	}, 0);
	var done = 0;
	var lastPercent = -1;
	function onBytes(count) {
		done += count;
		var percent = total ? Math.floor(done / total * 100) : 100;
		if (percent !== lastPercent) {
			lastPercent = percent;
			onProgress(percent);
		}
	}
	
	//the biggest files are the ones most worth not copying. references are only used for blobs, since a
	//stream reads each file as it goes
	var references = new Set();
	var chain = Promise.resolve();
	if (!port) {
		var candidates = kept.filter(function(item) {
			return item.file && item.file.size > referenceOver;
		}).sort(function(a, b) {
			return b.file.size - a.file.size;
		});
		chain = referenceLimit(candidates.map(function(item) {
			return item.file;
		})).then(function(limit) {
			references = new Set(candidates.slice(0, limit));
		});
	}
	
	var central = [];
	var position = 0;
	kept.forEach(function(item) {
		chain = chain.then(function() {
			var file = item.file;
			var time = file ? file.lastModified : Date.now();
			var c = {
				name: utf8Encoder.encode(item.path),
				when: dosDateTime(time),
				timestamp: timestampField(time),
				offset: position,
				isFile: !!file,
				streamed: !!port && !!file && file.size > 0,
				crc: 0,
				size: 0,
				dataSize: 0,
				method: 0
			};
			//compressing means holding the compressed copy in a blob, so very big files are only compressed
			//when streaming
			var shrink = compress && !!file && file.size > 0 && !alreadyCompressed.test(item.path) && (!!port || file.size <= compressLimit);
			central.push(c);
			
			if (c.streamed) {
				c.method = shrink ? 8 : 0;
				c.zip64 = file.size >= 0xFFFF0000;
				var local = localHeader(c);
				return output.write(local).then(function() {
					return streamFile(file, shrink, output, onBytes);
				}).then(function(entry) {
					c.crc = entry.crc;
					c.size = entry.size;
					c.dataSize = entry.dataSize;
					var descriptor = dataDescriptor(c);
					position += local.length + entry.dataSize + descriptor.length;
					return output.write(descriptor);
				});
			}
			
			var prepared = file ? prepareFile(file, shrink, references.has(item), onBytes) : Promise.resolve({crc: 0, size: 0, method: 0, data: [], dataSize: 0});
			return prepared.then(function(entry) {
				c.crc = entry.crc;
				c.size = entry.size;
				c.dataSize = entry.dataSize;
				c.method = entry.method;
				c.zip64 = entry.size >= 0xFFFFFFFF || entry.dataSize >= 0xFFFFFFFF;
				var local = localHeader(c);
				position += local.length + entry.dataSize;
				return entry.data.reduce(function(previous, piece) {
					return previous.then(function() {
						return output.write(piece);
					});
				}, output.write(local));
			});
		});
	});
	
	return chain.then(function() {
		return zipEnd(central, position).reduce(function(previous, piece) {
			return previous.then(function() {
				return output.write(piece);
			});
		}, Promise.resolve());
	}).then(function() {
		return output.finish();
	}).then(function(blob) {
		return {entries: list, blob: blob, streamed: !!port, size: blob ? blob.size : output.size};
	}, function(error) {
		if (port) {
			output.fail(error.message);
		}
		throw error;
	});
}

function runTask(task, onProgress) {
	return task.type === 'folder' ? zipFolder(task.items, onProgress, task.port) : cleanZip(task.file);
}

//when running as a worker, take jobs from alt.js
if (typeof importScripts === 'function') {
	self.onmessage = function(e) {
		var id = e.data.id;
		runTask(e.data.task, function(percent) {
			self.postMessage({id: id, type: 'progress', percent: percent});
		})
		.then(function(result) {
			self.postMessage({id: id, type: 'done', entries: result.entries, blob: result.blob, streamed: result.streamed, size: result.size});
		}, function(error) {
			self.postMessage({id: id, type: 'error', message: error.message});
		});
	};
}
