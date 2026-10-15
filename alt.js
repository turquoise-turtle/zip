if ('serviceWorker' in navigator) {
	window.addEventListener('load', function() {
		//the scope keeps it to /zip/, since other apps (like /pdf/) live on the same domain
		navigator.serviceWorker.register('service-worker.js', {scope: './'})
		.catch(function(error) {
			console.log('Service worker registration failed:', error);
		});
	});
}

var fileElem = document.querySelector('#fileElem');
var remc = document.querySelector('#remc');
var rem = document.querySelector('#rem');
var statusBox = document.querySelector('#status');

//remember the rename settings. keys start with zip: because other apps on this domain share the same storage
function loadSetting(key) {
	try {
		return localStorage.getItem('zip:' + key);
	} catch (error) {
		return null;
	}
}

function saveSetting(key, value) {
	try {
		localStorage.setItem('zip:' + key, value);
	} catch (error) {
		//private browsing or storage turned off, so it just won't be remembered
	}
}

if (loadSetting('renameEnabled') !== null) {
	remc.checked = loadSetting('renameEnabled') === 'true';
}
if (loadSetting('renameText') !== null) {
	rem.value = loadSetting('renameText');
}

remc.addEventListener('change', function() {
	saveSetting('renameEnabled', remc.checked);
}, false);

rem.addEventListener('input', function() {
	fitRem();
	saveSetting('renameText', rem.value);
}, false);

//grow the text box to fit what's typed, so it looks like part of the sentence
var measure = document.createElement('canvas').getContext('2d');
function fitRem() {
	var style = getComputedStyle(rem);
	measure.font = style.fontWeight + ' ' + style.fontSize + ' ' + style.fontFamily;
	rem.style.width = Math.max(Math.ceil(measure.measureText(rem.value).width) + 2, parseFloat(style.fontSize)) + 'px';
}
fitRem();

//takes the text off the end of the name (before .zip), e.g. photos-raw.zip becomes photos.zip
function newName(name) {
	var query = rem.value.trim();
	if (!remc.checked || !query) {
		return name;
	}
	var ext = /\.zip$/i.test(name) ? name.slice(-4) : '';
	var base = name.slice(0, name.length - ext.length);
	if (base.length > query.length && base.slice(-query.length) === query) {
		base = base.slice(0, -query.length);
	}
	return base + ext;
}

fileElem.addEventListener('change', function() {
	var files = Array.prototype.slice.call(this.files);
	//so picking the same zip again still counts as a change
	this.value = '';
	handleFiles(files);
}, false);

function handleFiles(files) {
	if (files.length !== 1) {
		showStatus('Please choose one zip at a time.');
		return;
	}
	var file = files[0];
	if (!/\.zip$/i.test(file.name) && file.type.indexOf('zip') === -1) {
		showStatus('"' + file.name + '" isn\'t a zip file.');
		return;
	}
	var name = newName(file.name);

	showStatus('Reading…', null, null, true);
	runClean(file, function(percent) {
		showStatus('Cleaning… ' + percent + '%', null, null, true);
	})
	.then(function(result) {
		showResult(file, name, result);
	}, function(error) {
		showStatus(error.message);
	});
}

function showResult(file, name, result) {
	var entries = result.entries;
	var kept = entries.filter(function(entry) {
		return !entry.reason;
	});

	fillList(document.querySelector('#left'), entries);
	document.querySelector('#itemsleft').textContent = plural(entries.length, 'item');
	fillList(document.querySelector('#right'), kept);
	document.querySelector('#itemsright').textContent = plural(kept.length, 'item');
	document.querySelector('#lists').classList.remove('hidden');

	if (!result.blob) {
		showStatus('Nothing to remove. This zip is already clean.');
		return;
	}

	download(result.blob, name);
	var summary = 'Removed ' + (entries.length - kept.length) + ' of ' + plural(entries.length, 'item');
	var saved = file.size - result.blob.size;
	if (saved > 0) {
		summary += ', ' + formatSize(saved) + ' smaller';
	}
	showStatus(summary + '. ', result.blob, name);
}

//the message under "Select zip". blob and name add a "download again" link, busy stops screen readers reading every percent
function showStatus(text, blob, name, busy) {
	statusBox.textContent = text;
	statusBox.setAttribute('aria-busy', busy ? 'true' : 'false');
	if (blob) {
		var again = document.createElement('a');
		again.href = '#';
		again.textContent = 'Download again';
		again.addEventListener('click', function(e) {
			e.preventDefault();
			download(blob, name);
		}, false);
		statusBox.appendChild(again);
	}
}

//only show the first lot, because thousands of rows makes the page sluggish
var maxRows = 1000;
function fillList(list, entries) {
	var fragment = document.createDocumentFragment();
	entries.slice(0, maxRows).forEach(function(entry) {
		var item = document.createElement('li');
		item.textContent = entry.name;
		if (entry.reason) {
			item.classList.add('removed');
			item.title = entry.reason;
			//strike-through isn't read out, so say it for screen readers
			var note = document.createElement('span');
			note.classList.add('visually-hidden');
			note.textContent = ' (removed: ' + entry.reason + ')';
			item.appendChild(note);
		}
		fragment.appendChild(item);
	});
	if (entries.length > maxRows) {
		var more = document.createElement('li');
		more.classList.add('more');
		more.textContent = '+' + (entries.length - maxRows) + ' more';
		fragment.appendChild(more);
	}
	list.textContent = '';
	list.appendChild(fragment);
}

function plural(count, word) {
	return count + ' ' + word + (count === 1 ? '' : 's');
}

function formatSize(bytes) {
	if (bytes < 1000) {
		return plural(bytes, 'byte');
	}
	var units = ['KB', 'MB', 'GB'];
	var i = -1;
	do {
		bytes /= 1000;
		i++;
	} while (bytes >= 1000 && i < units.length - 1);
	return bytes.toFixed(bytes < 10 ? 1 : 0) + ' ' + units[i];
}

function download(blob, name) {
	var url = URL.createObjectURL(blob);
	var link = document.createElement('a');
	link.href = url;
	link.download = name;
	document.body.appendChild(link);
	link.click();
	link.remove();
	//give the download time to start before freeing the memory
	setTimeout(function() {
		URL.revokeObjectURL(url);
	}, 10000);
}

//clean.js does the zip work in a worker so the page doesn't freeze. if the worker can't start, it runs here instead
var worker = null;
var workerFailed = false;
var jobCount = 0;
var current = null;

function runClean(file, onProgress) {
	return new Promise(function(resolve, reject) {
		//a new zip replaces one that's still going
		if (current && worker) {
			worker.terminate();
			worker = null;
		}
		current = {id: ++jobCount, file: file, onProgress: onProgress, resolve: resolve, reject: reject};
		startJob(current);
	});
}

function startJob(job) {
	var w = getWorker();
	if (w) {
		w.postMessage({id: job.id, file: job.file});
		return;
	}
	loadMainThread()
	.then(function() {
		return cleanZip(job.file, function(percent) {
			if (job === current) {
				job.onProgress(percent);
			}
		});
	})
	.then(function(result) {
		finishJob(job, result);
	}, function(error) {
		finishJob(job, null, error);
	});
}

function finishJob(job, result, error) {
	if (job !== current) {
		return;
	}
	current = null;
	if (error) {
		job.reject(error);
	} else {
		job.resolve(result);
	}
}

function getWorker() {
	if (!worker && !workerFailed) {
		try {
			worker = new Worker('clean.js');
			worker.onmessage = onWorkerMessage;
			worker.onerror = onWorkerError;
		} catch (error) {
			workerFailed = true;
		}
	}
	return worker;
}

function onWorkerMessage(e) {
	var data = e.data;
	if (!current || data.id !== current.id) {
		return;
	}
	if (data.type === 'progress') {
		current.onProgress(data.percent);
	} else if (data.type === 'done') {
		finishJob(current, data);
	} else {
		finishJob(current, null, new Error(data.message));
	}
}

function onWorkerError(e) {
	//the worker broke or couldn't load, so stop using it and redo this zip here
	e.preventDefault();
	worker = null;
	workerFailed = true;
	if (current) {
		startJob(current);
	}
}

var mainThread = null;
function loadMainThread() {
	if (!mainThread) {
		mainThread = loadScript('jszip.js').then(function() {
			return loadScript('clean.js');
		});
	}
	return mainThread;
}

function loadScript(src) {
	return new Promise(function(resolve, reject) {
		var script = document.createElement('script');
		script.src = src;
		script.onload = resolve;
		script.onerror = function() {
			reject(new Error('Couldn\'t load ' + src + '. Check your connection and reload the page.'));
		};
		document.head.appendChild(script);
	});
}

var dropbox;
dropbox = document.querySelector('.container');

dropbox.addEventListener("dragenter", dragenter, false);
dropbox.addEventListener("dragover", dragover, false);
dropbox.addEventListener("drop", drop, false);
dropbox.addEventListener("dragleave", dragleave, false);

function dragenter(e) {
	e.stopPropagation();
	e.preventDefault();
}

function dragover(e) {
	e.stopPropagation();
	e.preventDefault();
	dropbox.classList.add('animated');
}

function dragleave(e) {
	e.stopPropagation();
	e.preventDefault();
	dropbox.classList.remove('animated');
}

function drop(e) {
	e.stopPropagation();
	e.preventDefault();
	dropbox.classList.remove('animated');

	var dt = e.dataTransfer;
	var files = dt.files;
	handleFiles(files);
}

//stop a zip dropped next to the box from opening in the browser and leaving the page
window.addEventListener('dragover', function(e) {
	e.preventDefault();
	e.dataTransfer.dropEffect = 'none';
}, false);

window.addEventListener('drop', function(e) {
	e.preventDefault();
}, false);
