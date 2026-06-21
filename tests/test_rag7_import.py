import os
import subprocess
import sys


def test_rag7_imports_without_torch_text_splitter_dependency():
    env = os.environ.copy()
    env.setdefault("NEXT_PUBLIC_SUPABASE_URL", "http://localhost:54321")
    env.setdefault("SUPABASE_SERVICE_ROLE_KEY", "test-service-role-key")

    result = subprocess.run(
        [sys.executable, "-c", "import rag7; print('import ok')"],
        cwd=os.path.dirname(os.path.dirname(__file__)),
        env=env,
        capture_output=True,
        text=True,
        timeout=30,
    )

    assert result.returncode == 0, result.stderr
    assert "import ok" in result.stdout
