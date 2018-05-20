//foreach way
document.querySelector('#fileElem').addEventListener('change', function() {
	handleFiles(this.files);
}, false);

function handleFiles(files) {
	var fileblob = files[0];
	var name = fileblob.name;
		
	var zip = new JSZip();
	
	zip.loadAsync(fileblob)
	.then(function(contents){
		//console.log(contents);
		Object.keys(zip.files).forEach(function (filename) {
			if (filename.indexOf('__MACOSX/') !== -1 || filename.indexOf('.DS_Store') !== -1) {
				zip.remove(filename);
			}
		});
		console.log(zip);
		/*zip.generateAsync({type:"base64"}).then(function (base64) {
			location.href="data:application/zip;base64," + base64;
		});*/
		zip.generateAsync({type:"blob"})
		.then(function(content) {
			saveAs(content, name);
		});
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
