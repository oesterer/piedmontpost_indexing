import fs from 'node:fs/promises';
import path from 'node:path';
// Migration cleanup only; never remove the immutable JSON index generations.
export async function removeSidecars(directory){
 const entries=await fs.readdir(directory,{withFileTypes:true}).catch(error=>{if(error.code==='ENOENT')return [];throw error;});
 const files=entries.filter(entry=>entry.isFile()&&/\.json\.(gz|br)$/.test(entry.name));
 for(const file of files)await fs.unlink(path.join(directory,file.name));
 return files.length;
}
