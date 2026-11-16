"""Empaqueta sólo archivos de ejecución y marca pública, sin documentos internos."""
from pathlib import Path
import json
import zipfile

root = Path(__file__).resolve().parents[1]
manifest = json.loads((root / 'manifest.json').read_text())
files = ['manifest.json', 'background.js', 'content.js', 'popup.js', 'popup.html',
         'popup.css', 'utils.js', 'icons.js', 'excel_export.js', 'emite_sync.js',
         'privacy.html', 'privacy.css', *[f'icon-{n}.png' for n in (16, 32, 48, 128)],
         'assets/emite-logo-full.svg', 'assets/emite-logo-full-white.svg']
out = root / 'dist' / f'sri-pro-xml-{manifest["version"]}.zip'
out.parent.mkdir(exist_ok=True)
with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as archive:
    for name in sorted(files):
        archive.write(root / name, name)
print(out)
