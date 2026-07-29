import sys
from pathlib import Path

# src レイアウトなので、インストールしなくてもテストできるようにする
ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "src"))
