#!/usr/bin/env python3
"""changelog.py next 의 버전 선택 규칙 자체 점검 (ADR-0040).

머지 직후 워크플로가 이 규칙으로 버전을 고른다. 사람이 고르던 자리라 규칙이 틀리면
번호가 조용히 어긋난다. 네 경우를 고정한다.
"""
import os
import pathlib
import subprocess
import sys
import tempfile

SCRIPT = pathlib.Path(__file__).resolve().parent / 'changelog.py'
HEAD = '# C\n<!-- bump-version.sh 삽입 지점 -->\n\n## [Unreleased]\n\n'
TAIL = '## [1.2.3] - 2026-01-01\n\n### Added\n* old (#0)\n'
CASES = [
    ('비어 있음 → 출력 없음', '', ''),
    ('Fixed 만 → PATCH', '### Fixed\n* a (#1)\n\n', '1.2.4'),
    ('Added 포함 → MINOR', '### Added\n* a (#1)\n\n### Fixed\n* b (#2)\n\n', '1.3.0'),
    ('파괴 변경 → MAJOR', '### Changed\n* **BREAKING** a (#1)\n\n### Added\n* b (#2)\n\n', '2.0.0'),
    ('Deprecated → MINOR (지원 중단 예고는 기능 변경)', '### Deprecated\n* a (#1)\n\n### Fixed\n* b (#2)\n\n', '1.3.0'),
    ('지난 버전의 Added 는 세지 않음', '### Changed\n* a (#1)\n\n', '1.2.4'),
]

fail = 0
with tempfile.TemporaryDirectory() as d:
    for name, block, want in CASES:
        pathlib.Path(d, 'CHANGELOG.md').write_text(HEAD + block + TAIL, encoding='utf-8')
        env = dict(os.environ, ROOT_DIR=d, PREV_VERSION='1.2.3')
        got = subprocess.run([sys.executable, str(SCRIPT), 'next'], env=env,
                             capture_output=True, text=True).stdout.strip()
        ok = got == want
        fail += not ok
        print('%s %s (기대 %r, 실제 %r)' % ('✔' if ok else '✘', name, want, got))

sys.exit(1 if fail else 0)
