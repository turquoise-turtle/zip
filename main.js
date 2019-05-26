//this was the hard way:
//I was trying to make it so you could drag in a bunch of files and it would keep the directory
//structure but not zip any __MACOSX files, but it just turned out too complicated, so I ended
//up making alt.js which takes an already created zip and just removes the __MACOSX files from
//there.

document.querySelector('#fileElem').addEventListener('change', function() {
	handleFiles(this.files);
}, false);

function handleFiles(items) {
	//var fileblob = param[0];
	//console.log(fileblob.name);
	
	//var objectURL = window.URL.createObjectURL(fileblob);
	
	//var ext = fileblob.name.split('.').pop();
	//if (ext == 'zip') { unzipit(objectURL); }
	//else if ( ext == 'swf' ) { swfit(objectURL); }
	//else { console.log(ext); }
	var zip = new JSZip();
	
	var proms = [];
	proms.push(new Promise(function(resolve, reject) {setTimeout(resolve, 200, 'hello');}));
	
	//for (var file of files) {
	/*for (var i = 0; i < items.length; i++) { 
		var item = items[i];
		var file = files[i];
		
		var filef = item.webkitGetAsEntry();
		console.log(filef);
		console.log(file);
		var nam = filef.fullPath.split('/')[1];
		
		console.log(filef.name);
		if (filef.isDirectory) {
			console.log('dir');
		} else {
			//console.log(nam)[1];
			zip.file(nam, file)
		}
	}*/
	
	gofile(items);
	
	function gofile(itemlist) {
		for (var i = 0; i < itemlist; i ++) {
			//var file = filelist[i];
			var item = itemlist[i];
			
			var filef = item.webkitGetAsEntry();
			console.log(filef);
			//console.log(file);
			
			
			if (filef.isDirectory) {
				var dirReader = entry.createReader();
				proms.push(
					new Promise(function(resolve,reject){
						dirReader.readEntries(function(results) {
							gofile(itemlist);
						});
						resolve();
					})
				);
			} else {
				proms.push(
					new Promise(function(resolve,reject){
						var nam = filef.fullPath.split('/')[1];
						console.log(nam);
						item.file(function(blob){
							zip.file(nam, blob);
						});
					})
				);
			}
		}
	}
	
	
	Promise.all(proms).then(function(values) {
  		zip.generateAsync({type:"base64"}).then(function (base64) {
			location.href="data:application/zip;base64," + base64;
		});
	});
	
	
	
	
	//https://stackoverflow.com/questions/13555785/remove-all-child-from-node-with-the-same-class-pure-js/13555954#13555954
	var elements = document.getElementsByClassName('deleteme');
	while (elements[0]) {
		elements[0].parentNode.removeChild(elements[0]);
	}
}

var dropbox;

dropbox = document.body;
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

  var dt = e.dataTransfer;
  var files = dt.files;
  var items = dt.items;

	var l = [];
	for (var file of items) {
		var filef = file.webkitGetAsEntry();
		l.push(filef);
	}
  //handleFiles(l);
  handleFiles(items);
}