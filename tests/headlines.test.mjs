import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';

test('PDF headings keep smaller decks searchable under the main title', {skip:process.platform!=='darwin'},async()=>{
 const dir=await mkdtemp(path.join(tmpdir(),'post-headlines-'));
 try{
  const source=(await readFile(new URL('../scripts/index-pdfs.swift',import.meta.url),'utf8')).split('// Single-issue mode')[0];
  // Typography/coordinates from October 14, 2026, page 12, with a compact body fixture.
  const fixture=`
func line(_ id: Int,_ text: String,_ x: CGFloat,_ y: CGFloat,_ width: CGFloat,_ size: CGFloat) -> PDFLine {
 return PDFLine(id:id,text:text,box:CGRect(x:x,y:y,width:width,height:size),size:size)
}
let title = "Athletes of the Week: Viviane Oesterer, Vaha Mafi"
let deck = "Honorable Mention: Ella Ruthven, Henry Stein"
let body = String(repeating: "Viviane Oesterer leads the Highlanders. ",count:8)
let lines = [
 line(0,"Athletes of the Week:",475.5,1061,195.8,25.8),
 line(1,"Viviane Oesterer, Vaha Mafi",475.5,1033.5,257.5,25.8),
 line(2,"Honorable Mention:",475.5,1014.3,124.9,18),
 line(3,"Ella Ruthven, Henry Stein",475.5,992.3,158.9,18),
 line(4,body,475.5,720,135,10)
]
let articles = detectedArticles(lines:lines,bounds:CGRect(x:0,y:0,width:792,height:1224))
assert(articles.count == 1)
assert(articles[0]["title"] as? String == title)
assert((articles[0]["text"] as! String).contains(deck))
// A smaller heading separated by body text is a separate article.
let separate = [line(0,"First independent headline",35,900,250,26),line(1,body,35,880,135,10),line(2,"Second independent headline",35,850,250,18),line(3,body,35,820,135,10)]
assert(detectedArticles(lines:separate,bounds:CGRect(x:0,y:0,width:792,height:1224)).count == 2)
print("headlines passed")
`;
  const file=path.join(dir,'test.swift');await writeFile(file,source+fixture);
  assert.match(execFileSync('swift',['-module-cache-path',path.join(tmpdir(),'piedmont-swift-modules'),file],{encoding:'utf8'}),/headlines passed/);
 }finally{await rm(dir,{recursive:true,force:true});}
});
