import json

import httpx
import pytest

from server.drive import Drive
from server.storage import Settings, durable_write


@pytest.fixture
def configured(tmp_path, monkeypatch):
    monkeypatch.setenv("DRIVE_CLIENT_ID", "test-client")
    monkeypatch.setenv("DRIVE_CLIENT_SECRET", "test-secret")
    monkeypatch.setenv("DRIVE_ROOT_ID", "existing-root")
    settings = Settings(tmp_path / "state", tmp_path / "work", tmp_path / "archive")
    durable_write(settings.state / "drive-token.json", b'{"refresh_token":"test-refresh"}')
    return settings


def test_lost_upload_response_reconciles_identity(configured):
    export = {"id": "test-export", "sha256": "a" * 64, "path": "2026/09-September/20260914-1721.pdf"}
    durable_write(configured.archive / export["path"], b"%PDF-test")
    uploaded = False
    upload_count = 0

    def handler(request):
        nonlocal uploaded, upload_count
        if request.url.host == "oauth2.googleapis.com":
            return httpx.Response(200, json={"access_token": "test-token"})
        if request.url.path == "/drive/v3/files" and request.method == "GET":
            query = request.url.params["q"]
            if "appProperties" in query:
                files = [{"id": "remote-id", "appProperties": {"sha256": export["sha256"]}}] if uploaded else []
            elif "name='2026'" in query:
                files = [{"id": "year", "mimeType": "application/vnd.google-apps.folder"}]
            elif "name='09-September'" in query:
                files = [{"id": "month", "mimeType": "application/vnd.google-apps.folder"}]
            else:
                files = []
            return httpx.Response(200, json={"files": files})
        if request.url.path == "/upload/drive/v3/files":
            upload_count += 1
            assert "permissions" not in json.loads(request.content)
            return httpx.Response(200, headers={"Location": "https://www.googleapis.com/resumable-session"})
        if request.url.path == "/resumable-session":
            uploaded = True
            raise httpx.ReadTimeout("lost successful response")
        raise AssertionError(str(request.url))

    drive = Drive(configured, httpx.Client(transport=httpx.MockTransport(handler)))
    with pytest.raises(httpx.ReadTimeout):
        drive.upload(export)
    assert drive.upload(export) == "remote-id"
    assert upload_count == 1


def test_remote_filename_conflict_preserves_existing_file(configured):
    requests = []

    def handler(request):
        requests.append(request.method)
        if request.url.host == "oauth2.googleapis.com":
            return httpx.Response(200, json={"access_token": "test-token"})
        query = request.url.params["q"]
        if "appProperties" in query:
            files = []
        elif "name='2026'" in query or "name='09-September'" in query:
            files = [{"id": "folder", "mimeType": "application/vnd.google-apps.folder"}]
        else:
            files = [{"id": "somebody-elses-file", "mimeType": "application/pdf"}]
        return httpx.Response(200, json={"files": files})

    drive = Drive(configured, httpx.Client(transport=httpx.MockTransport(handler)))
    with pytest.raises(ValueError, match="occupied"):
        drive.upload({"id": "new-export", "sha256": "a" * 64, "path": "2026/09-September/20260914-1721.pdf"})
    assert "PUT" not in requests and "PATCH" not in requests and "DELETE" not in requests


def test_oauth_state_expiry_replay_and_token_permissions(configured):
    from fastapi.testclient import TestClient
    from server.api import create_app

    def handler(request):
        if request.url.host == "oauth2.googleapis.com":
            return httpx.Response(200, json={"access_token": "test-token", "refresh_token": "new-refresh"})
        return httpx.Response(200, json={"id": "existing-root", "mimeType": "application/vnd.google-apps.folder", "capabilities": {"canAddChildren": True}})

    drive = Drive(configured, httpx.Client(transport=httpx.MockTransport(handler)))
    app = create_app(configured, drive)
    client = TestClient(app, base_url=configured.public_url, headers={"Origin": configured.public_url, "Content-Type": "application/json"})
    result = client.post("/api/drive/connect").json()
    from urllib.parse import parse_qs, urlsplit
    state = parse_qs(urlsplit(result["url"]).query)["state"][0]
    assert client.get("/api/drive/callback?state=wrong&code=test").status_code == 400
    assert client.get(f"/api/drive/callback?state={state}&code=test", follow_redirects=False).status_code == 303
    assert client.get(f"/api/drive/callback?state={state}&code=test").status_code == 400
    assert json.loads(drive.token_path.read_text()) == {"refresh_token": "new-refresh"}
    assert drive.token_path.stat().st_mode & 0o777 == 0o600
