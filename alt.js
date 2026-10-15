if ('serviceWorker' in navigator) {
	window.addEventListener('load', function() {
		navigator.serviceWorker.register('/zip/service-worker.js')
		.then(function (reg){
			console.log('sw registered:', reg);
		}, /*catch*/ function(error) {
			console.log('Service worker registration failed:', error);
		});
	});
}

//foreach way
document.querySelector('#fileElem').addEventListener('change', function() {
	handleFiles(this.files);
}, false);

function handleFiles(files) {
	var fileblob = files[0];
	var name = fileblob.name;
	
	var namechange = document.querySelector('#remc').checked;
	if (namechange) {
		var query = document.querySelector('#rem').innerText;
		name = name.replace(query, '');
	}
		
	var zip = new JSZip();
	
	zip.loadAsync(fileblob)
	.then(function(contents){
		//console.log(contents);
		
		var xy = document.querySelector('#left');
		var xz = document.querySelector('#right');
		
		//og is original, np is no problem (new list)
		var og = [];
		var np = [];
		
		//delete the previous lists, if any
		//https://stackoverflow.com/questions/13555785/remove-all-child-from-node-with-the-same-class-pure-js/13555954#13555954
		var elements = document.getElementsByClassName('deleteme');
		while (elements[0]) {
			elements[0].parentNode.removeChild(elements[0]);
		}
		
		if (document.querySelector('.hidden')) {
			document.querySelector('.hidden').classList.remove('hidden');
		}
		
		Object.keys(zip.files).forEach(function (filename) {
			og.push(filename);
			//skip anything already removed along with a hidden folder
			if (zip.files[filename] && isHidden(filename, zip.files[filename])) {
				zip.remove(filename);
			}
		});
		
		//build the new list from what's left, because removing a hidden folder also removes everything inside it
		np = Object.keys(zip.files);
		
		for (var i of og) {
			var newchild = document.createElement('li');
			newchild.classList.add('deleteme');
			newchild.innerText = i;
			xy.appendChild(newchild);
		}
		document.querySelector('#itemsleft').innerText = og.length + ' items';
		
		for (var i of np) {
			var newchild = document.createElement('li');
			newchild.classList.add('deleteme');
			newchild.innerText = i;
			xz.appendChild(newchild);
		}
		document.querySelector('#itemsright').innerText = np.length + ' items';
		
		
		console.log(zip);
		
		//location.href="data:application/zip;base64," + base64;
		zip.generateAsync({type:"blob"})
		.then(function(content) {
			saveAs(content, name);
		});
	});
	
	
}

//files and folders windows makes behind the scenes (lowercase, because windows filenames aren't case sensitive)
var windowsHidden = [
	'thumbs.db',
	'ehthumbs.db',
	'ehthumbs_vista.db',
	'desktop.ini',
	'$recycle.bin',
	'system volume information'
];

function isHidden(filename, file) {
	//mac
	if (filename.indexOf('__MACOSX/') !== -1 || filename.indexOf('.DS_Store') !== -1) {
		return true;
	}
	
	//windows, check every part of the path so things inside hidden folders get removed too
	var parts = filename.toLowerCase().split('/');
	for (var part of parts) {
		if (windowsHidden.indexOf(part) !== -1) {
			return true;
		}
	}
	
	//windows hidden attribute, only set when the zip was made on windows
	//https://docs.microsoft.com/en-us/windows/desktop/fileio/file-attribute-constants (FILE_ATTRIBUTE_HIDDEN is 2)
	if (file.dosPermissions && (file.dosPermissions & 2)) {
		return true;
	}
	
	return false;
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