const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const outDir = path.join(root, 'dist');
const copyTargets = [
  'src',
  'web',
  'configs',
  'examples',
  'README.md',
  'README.en.md',
  'QUICKSTART.md',
  'PROJECT_SUMMARY.md',
  'Transfer.md'
];

async function ensureDir(dirPath) {
  await fs.promises.mkdir(dirPath, { recursive: true });
}

async function exists(filePath) {
  try {
    await fs.promises.access(filePath, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function copyDir(src, dest) {
  await ensureDir(dest);
  const entries = await fs.promises.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      await copyDir(srcPath, destPath);
    } else if (entry.isFile()) {
      await fs.promises.copyFile(srcPath, destPath);
    }
  }
}

async function copyPath(relPath) {
  const srcPath = path.join(root, relPath);
  const destPath = path.join(outDir, relPath);
  if (!(await exists(srcPath))) {
    return false;
  }
  const stat = await fs.promises.stat(srcPath);
  if (stat.isDirectory()) {
    await copyDir(srcPath, destPath);
  } else if (stat.isFile()) {
    await ensureDir(path.dirname(destPath));
    await fs.promises.copyFile(srcPath, destPath);
  }
  return true;
}

async function createDistPackageJson() {
  const pkgPath = path.join(root, 'package.json');
  const raw = await fs.promises.readFile(pkgPath, 'utf8');
  const pkg = JSON.parse(raw);
  const distPkg = {
    name: pkg.name,
    version: pkg.version,
    description: pkg.description,
    main: pkg.main,
    bin: pkg.bin,
    scripts: {
      start: pkg.scripts?.start,
      cli: pkg.scripts?.cli,
      web: pkg.scripts?.web
    },
    dependencies: pkg.dependencies,
    engines: pkg.engines,
    keywords: pkg.keywords,
    author: pkg.author,
    license: pkg.license
  };
  await fs.promises.writeFile(
    path.join(outDir, 'package.json'),
    `${JSON.stringify(distPkg, null, 2)}\n`,
    'utf8'
  );
}

async function main() {
  await fs.promises.rm(outDir, { recursive: true, force: true });
  await ensureDir(outDir);

  const copied = [];
  for (const target of copyTargets) {
    if (await copyPath(target)) {
      copied.push(target);
    }
  }

  await createDistPackageJson();
  console.log(`Build output: ${outDir}`);
  console.log(`Copied: ${copied.join(', ')}`);
  console.log('Generated: package.json');
}

main().catch((err) => {
  console.error('Build failed:', err.message);
  process.exit(1);
});
