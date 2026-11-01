from backend.app import auth
from backend.app.bootstrap import DEMO_DB, DEMO_OFFICER, bootstrap
from backend.app.store import Store


def test_demo_snapshot_is_loaded_once_and_holds_no_logins(tmp_path):
    assert DEMO_DB.exists(), "run scripts/make_demo_db.py"
    data = tmp_path / "data"
    done = bootstrap(data)
    assert done[0] == "loaded demo database from awaaz-demo.db"
    store = Store(data / "awaaz.db")
    complaints = store.recent(limit=200)
    assert len(complaints) > 20
    # every photo the snapshot points to ships with it
    files = [c["photo"]["file"] for c in complaints if c["photo"]]
    assert files and all((data / "photos" / f).is_file() for f in files)
    assert {c["area"].rsplit(", ", 1)[-1] for c in complaints} >= {"Supaul", "Forbesganj"}
    assert store.officer(DEMO_OFFICER) is None
    store.close()
    assert bootstrap(data) == []  # an existing database is never overwritten


def test_demo_officer_password_comes_from_env(tmp_path):
    bootstrap(tmp_path, officer_password="first")
    bootstrap(tmp_path, officer_password="second")
    store = Store(tmp_path / "awaaz.db")
    assert auth.login(store, DEMO_OFFICER, "first") is None
    token, officer = auth.login(store, DEMO_OFFICER, "second")
    assert officer["department"] == "all"
    store.close()
