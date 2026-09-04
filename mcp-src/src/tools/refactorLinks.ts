import * as fs from 'fs/promises';
import * as path from 'path';

function escapeRegExp(string: string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Scans the vault for links pointing to `oldRelPath` and updates them to `newRelPath`.
 * 
 * @param vaultRoot Absolute path to the vault root
 * @param oldRelPath Relative path to the old note (e.g. 'folder/old.md' or 'old.md')
 * @param newRelPath Relative path to the new note (e.g. 'folder/new.md' or 'new.md')
 * @returns number of files updated
 */
export async function updateBacklinks(vaultRoot: string, oldRelPath: string, newRelPath: string): Promise<number> {
    const oldName = path.basename(oldRelPath, '.md');
    const newName = path.basename(newRelPath, '.md');
    
    // Normalize paths to forward slashes for link matching
    const oldRelPathForward = oldRelPath.replace(/\\/g, '/');
    const oldRelPathWithoutExt = oldRelPathForward.endsWith('.md') 
        ? oldRelPathForward.slice(0, -3) 
        : oldRelPathForward;
        
    const possibleTargets = [
        oldName,
        oldRelPathWithoutExt,
        oldName + '.md',
        oldRelPathForward
    ];
    
    const uniqueTargets = [...new Set(possibleTargets)];
    const targetsPattern = uniqueTargets.map(escapeRegExp).join('|');
    
    // Regex for [[LinkTarget]], [[LinkTarget#heading]], [[LinkTarget|alias]], [[LinkTarget#heading|alias]]
    const wikilinkRegex = new RegExp(`\\[\\[(${targetsPattern})(#[^|\\]]*)?(\\|[^\\]]*)?\\]\\]`, 'gi');
    
    // Regex for [alias](LinkTarget)
    const mdTargets = [
        oldName + '.md',
        oldRelPathForward,
        encodeURI(oldName + '.md'),
        encodeURI(oldRelPathForward)
    ];
    const uniqueMdTargets = [...new Set(mdTargets)];
    const mdTargetsPattern = uniqueMdTargets.map(escapeRegExp).join('|');
    const mdLinkRegex = new RegExp(`\\[([^\\]]*)\\]\\((${mdTargetsPattern})\\)`, 'gi');
    
    const files = await getAllMdFiles(vaultRoot);
    let updatedCount = 0;
    
    for (const file of files) {
        const content = await fs.readFile(file, 'utf-8');
        let newContent = content;
        let fileChanged = false;
        
        newContent = newContent.replace(wikilinkRegex, (match, p1, p2, p3) => {
            fileChanged = true;
            const hash = p2 || '';
            let alias = p3 || '';
            
            return `[[${newName}${hash}${alias}]]`;
        });
        
        newContent = newContent.replace(mdLinkRegex, (match, p1, p2) => {
            fileChanged = true;
            return `[${p1}](${encodeURI(newName + '.md')})`;
        });
        
        if (fileChanged) {
            await fs.writeFile(file, newContent, 'utf-8');
            updatedCount++;
        }
    }
    
    return updatedCount;
}

async function getAllMdFiles(dir: string, fileList: string[] = []): Promise<string[]> {
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
        if (entry.name.startsWith('.')) continue; // skip .trash, .obsidian, .git
        
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            await getAllMdFiles(fullPath, fileList);
        } else if (entry.isFile() && entry.name.endsWith('.md')) {
            fileList.push(fullPath);
        }
    }
    return fileList;
}
