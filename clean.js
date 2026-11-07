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

var crcTable = [];
for (var n = 0; n < 256; n++) {
	var c = n;
	for (var k = 0; k < 8; k++) {
		c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
	}
	crcTable[n] = c >>> 0;
}

//pass the previous result back in to carry on across chunks
function crc32(bytes, crc) {
	crc = (crc === undefined ? 0 : crc) ^ 0xFFFFFFFF;
	for (var i = 0; i < bytes.length; i++) {
		crc = crcTable[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
	}
	return (crc ^ 0xFFFFFFFF) >>> 0;
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
//Safari can only read about 2,000 files into one blob, so at most the 1,000 largest go in that way, and
//every other file goes in as the bytes read for its checksum
var referenceOver = 1024 * 1024;
var maxReferences = 1000;

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

//builds a zip from a folder's files, leaving out the hidden junk. items are {path, file}, with file null
//for an empty folder. resolves with {entries: [{name, reason}], blob}, where blob is null if everything
//was junk
function zipFolder(items, onProgress) {
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
		return Promise.resolve({entries: list, blob: null});
	}
	
	var compress = canCompress();
	var references = new Set(kept.filter(function(item) {
		return item.file && item.file.size > referenceOver;
	}).sort(function(a, b) {
		return b.file.size - a.file.size;
	}).slice(0, maxReferences));
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
	
	var pieces = new Pieces();
	var central = [];
	var position = 0;
	var chain = Promise.resolve();
	kept.forEach(function(item) {
		chain = chain.then(function() {
			if (!item.file) {
				return {crc: 0, size: 0, method: 0, data: [], dataSize: 0};
			}
			var shrink = compress && item.file.size > 0 && item.file.size <= compressLimit && !alreadyCompressed.test(item.path);
			return prepareFile(item.file, shrink, references.has(item), onBytes);
		}).then(function(entry) {
			var name = utf8Encoder.encode(item.path);
			var when = dosDateTime(item.file ? item.file.lastModified : Date.now());
			var seconds = Math.floor((item.file ? item.file.lastModified : Date.now()) / 1000);
			var big = entry.size >= 0xFFFFFFFF || entry.dataSize >= 0xFFFFFFFF;
			var version = big ? 45 : 20;
			
			//extended timestamp, so unzipping gets the exact time in any time zone
			var timestamp = new Uint8Array(9);
			set16(timestamp, 0, 0x5455);
			set16(timestamp, 2, 5);
			timestamp[4] = 1;
			set32(timestamp, 5, Math.max(0, Math.min(seconds, 0xFFFFFFFF)));
			var localExtra = timestamp;
			if (big) {
				localExtra = new Uint8Array(9 + 20);
				localExtra.set(timestamp);
				set16(localExtra, 9, 0x0001);
				set16(localExtra, 11, 16);
				set64(localExtra, 13, entry.size);
				set64(localExtra, 21, entry.dataSize);
			}
			
			var local = new Uint8Array(30 + name.length + localExtra.length);
			set32(local, 0, 0x04034B50);
			set16(local, 4, version);
			//names are utf-8
			set16(local, 6, 0x800);
			set16(local, 8, entry.method);
			set16(local, 10, when.time);
			set16(local, 12, when.date);
			set32(local, 14, entry.crc);
			set32(local, 18, big ? 0xFFFFFFFF : entry.dataSize);
			set32(local, 22, big ? 0xFFFFFFFF : entry.size);
			set16(local, 26, name.length);
			set16(local, 28, localExtra.length);
			local.set(name, 30);
			local.set(localExtra, 30 + name.length);
			
			central.push({item: item, entry: entry, name: name, when: when, timestamp: timestamp, offset: position, version: version});
			pieces.add(local);
			entry.data.forEach(function(piece) {
				pieces.add(piece);
			});
			position += local.length + entry.dataSize;
		});
	});
	
	return chain.then(function() {
		var records = central.map(function(c) {
			//zip64 fields are only there for the numbers too big to fit
			var zip64 = [];
			if (c.entry.size >= 0xFFFFFFFF) {
				zip64.push(c.entry.size);
			}
			if (c.entry.dataSize >= 0xFFFFFFFF) {
				zip64.push(c.entry.dataSize);
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
			var version = zip64.length ? 45 : c.version;
			var record = new Uint8Array(46 + c.name.length + extra.length);
			set32(record, 0, 0x02014B50);
			//made on unix, so the permissions below are read
			set16(record, 4, (3 << 8) | version);
			set16(record, 6, version);
			set16(record, 8, 0x800);
			set16(record, 10, c.entry.method);
			set16(record, 12, c.when.time);
			set16(record, 14, c.when.date);
			set32(record, 16, c.entry.crc);
			set32(record, 20, c.entry.dataSize >= 0xFFFFFFFF ? 0xFFFFFFFF : c.entry.dataSize);
			set32(record, 24, c.entry.size >= 0xFFFFFFFF ? 0xFFFFFFFF : c.entry.size);
			set16(record, 28, c.name.length);
			set16(record, 30, extra.length);
			//rw-r--r-- for files and rwxr-xr-x for folders, since browsers can't see the real permissions
			set32(record, 38, c.item.file ? 0x81A40000 : 0x41ED0010);
			set32(record, 42, c.offset >= 0xFFFFFFFF ? 0xFFFFFFFF : c.offset);
			record.set(c.name, 46);
			record.set(extra, 46 + c.name.length);
			return record;
		});
		var cdStart = position;
		var cdSize = records.reduce(function(sum, record) {
			return sum + record.length;
		}, 0);
		var cd = new Uint8Array(cdSize);
		var at = 0;
		records.forEach(function(record) {
			cd.set(record, at);
			at += record.length;
		});
		pieces.add(cd);
		position += cdSize;
		
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
			set64(locator, 8, position);
			set32(locator, 16, 1);
			pieces.add(zip64End);
			pieces.add(locator);
		}
		var end = new Uint8Array(22);
		set32(end, 0, 0x06054B50);
		set16(end, 8, Math.min(count, 0xFFFF));
		set16(end, 10, Math.min(count, 0xFFFF));
		set32(end, 12, Math.min(cdSize, 0xFFFFFFFF));
		set32(end, 16, Math.min(cdStart, 0xFFFFFFFF));
		pieces.add(end);
		
		return {entries: list, blob: pieces.blob()};
	});
}

function runTask(task, onProgress) {
	return task.type === 'folder' ? zipFolder(task.items, onProgress) : cleanZip(task.file);
}

//when running as a worker, take jobs from alt.js
if (typeof importScripts === 'function') {
	self.onmessage = function(e) {
		var id = e.data.id;
		runTask(e.data.task, function(percent) {
			self.postMessage({id: id, type: 'progress', percent: percent});
		})
		.then(function(result) {
			self.postMessage({id: id, type: 'done', entries: result.entries, blob: result.blob});
		}, function(error) {
			self.postMessage({id: id, type: 'error', message: error.message});
		});
	};
}
