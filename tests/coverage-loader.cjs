const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const root=path.resolve(__dirname,'..');
const dependencyRoot=process.env.AEGIS_TEST_REPO_ROOT||root;
const ts=require(path.join(dependencyRoot,'node_modules/typescript/lib/typescript.js'));
function loader(stubs={},globals={}) {
 const cache=new Map();
 function load(file){file=path.resolve(file);if(cache.has(file))return cache.get(file).exports;
  let source=file;if(!fs.existsSync(source)&&file.startsWith(root+path.sep))source=path.join(dependencyRoot,path.relative(root,file));
  const module={exports:{}};cache.set(file,module);
  const result=ts.transpileModule(fs.readFileSync(source,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,esModuleInterop:true},reportDiagnostics:true});
  if(result.diagnostics?.length)throw new Error(ts.formatDiagnosticsWithColorAndContext(result.diagnostics,{getCurrentDirectory:()=>root,getCanonicalFileName:x=>x,getNewLine:()=> '\n'}));
  const req=name=>Object.hasOwn(stubs,name)?stubs[name]:name.startsWith('.')?load(path.resolve(path.dirname(file),name)+'.ts'):require(name);
  vm.compileFunction(result.outputText,['require','module','exports',...Object.keys(globals)],{filename:source})(req,module,module.exports,...Object.values(globals));
  return module.exports;
 }return load;
}
module.exports={loader,root,dependencyRoot,lib:root+'/artifacts/api-server/src/lib/',services:root+'/artifacts/api-server/src/services/'};
