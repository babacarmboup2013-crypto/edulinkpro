import fs from 'fs';

const content = fs.readFileSync('EduLink Pro V1.jsx', 'utf8');
const lines = content.split('\n');
let braceCount = 0;
let lastGoodLine = -1;

for (let i = 0; i < lines.length; i++) {
  const line = lines[i];
  let inString = false;
  let stringChar = null;
  
  for (let j = 0; j < line.length; j++) {
    const char = line[j];
    const prevChar = j > 0 ? line[j-1] : '';
    
    if (!inString && (char === '"' || char === "'" || char === '`')) {
      if (prevChar !== '\\') {
        inString = true;
        stringChar = char;
      }
    } else if (inString && char === stringChar && prevChar !== '\\') {
      inString = false;
      stringChar = null;
    } else if (!inString && char === '{') {
      braceCount++;
    } else if (!inString && char === '}') {
      braceCount--;
    }
  }
  
  if (braceCount === 0) {
    lastGoodLine = i + 1;
  }
  
  if (braceCount < 0) {
    console.log(`Ligne ${i + 1}: Accolade fermante de trop`);
    console.log(`  ${line.substring(0, 120)}`);
    console.log(`  braceCount = ${braceCount}`);
    process.exit(0);
  }
}

if (braceCount > 0) {
  console.log(`Fin du fichier: ${braceCount} accolade(s) ouvrante(s) non fermée(s)`);
  console.log(`Dernière ligne avec des braces équilibrées: ligne ${lastGoodLine}`);
  console.log('');
  console.log('Affichage des 20 dernières lignes avec des accolades non équilibrées:');
  braceCount = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let inString = false;
    let stringChar = null;
    
    for (let j = 0; j < line.length; j++) {
      const char = line[j];
      const prevChar = j > 0 ? line[j-1] : '';
      
      if (!inString && (char === '"' || char === "'" || char === '`')) {
        if (prevChar !== '\\') {
          inString = true;
          stringChar = char;
        }
      } else if (inString && char === stringChar && prevChar !== '\\') {
        inString = false;
        stringChar = null;
      } else if (!inString && char === '{') {
        braceCount++;
      } else if (!inString && char === '}') {
        braceCount--;
      }
    }
    
    if (braceCount > 0 && i > lastGoodLine) {
      console.log(`${i + 1}: [${braceCount}] ${line.substring(0, 80)}`);
    }
  }
}
