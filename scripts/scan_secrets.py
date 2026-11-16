"""Busca patrones de credenciales en archivos actuales y blobs del historial Git.

No imprime el valor encontrado. No sustituye revisión humana ni detección de
secretos del proveedor. Ejecutar antes de publicar y tras incorporar ramas.
"""
from pathlib import Path
import re
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
PATTERNS = {
    'private-key': rb'-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----',
    'github-token': rb'gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}',
    'aws-access-key': rb'(?:AKIA|ASIA)[A-Z0-9]{16}',
    'jwt': rb'eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}',
    'credential-url': rb'(?:postgres(?:ql)?|redis|mysql)://[^\s:/]+:[^\s@]+@',
}
findings = set()

def check(data, source):
    if b'\0' in data:
        return
    for label, pattern in PATTERNS.items():
        if re.search(pattern, data):
            findings.add((source, label))

objects = subprocess.check_output(['git', 'rev-list', '--objects', '--all'], cwd=ROOT, text=True).splitlines()
blobs = 0
for obj in objects:
    sha, _, name = obj.partition(' ')
    kind = subprocess.check_output(['git', 'cat-file', '-t', sha], cwd=ROOT, text=True).strip()
    if kind != 'blob':
        continue
    blobs += 1
    check(subprocess.check_output(['git', 'cat-file', 'blob', sha], cwd=ROOT), f'{sha[:12]}:{name}')
for path in ROOT.rglob('*'):
    if any(part in {'.git', 'node_modules', 'dist'} for part in path.relative_to(ROOT).parts):
        continue
    if path.is_file():
        check(path.read_bytes(), str(path.relative_to(ROOT)))
print(f'Blobs históricos revisados: {blobs}; hallazgos por patrón: {len(findings)}')
for source, label in sorted(findings):
    print(f'{label}: {source}')
sys.exit(bool(findings))
