'use strict';

/**
 * 테스트용 GitHub API mock 서버.
 *
 * 실제 GitHub 계정/토큰을 절대 건드리지 않고 로그인 플로우를 검증하기 위한 것.
 * 실행하면 준비된 포트를 `LISTENING <port>` 로 stdout 에 출력한다.
 *
 *   AUTOGIT_GITHUB_API_BASE=http://127.0.0.1:<port> 로 앱/테스트에서 사용.
 */

const http = require('http');

const GOOD_TOKEN = process.env.MOCK_GOOD_TOKEN || 'good-token';

function send(res, status, body) {
  const payload = body == null ? '' : JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
    'X-OAuth-Scopes': 'repo, read:user',
  });
  res.end(payload);
}

const USER = {
  login: 'mockuser',
  name: 'Mock User',
  avatar_url: 'https://avatars.githubusercontent.com/u/0?v=4',
  html_url: 'https://github.com/mockuser',
  public_repos: 3,
  total_private_repos: 1,
};

const REPOS = [
  {
    full_name: 'mockuser/hello',
    name: 'hello',
    owner: { login: 'mockuser' },
    private: false,
    description: 'demo repo',
    clone_url: 'https://github.com/mockuser/hello.git',
    ssh_url: 'git@github.com:mockuser/hello.git',
    html_url: 'https://github.com/mockuser/hello',
    default_branch: 'main',
    updated_at: '2026-01-01T00:00:00Z',
  },
  {
    full_name: 'mockuser/secret',
    name: 'secret',
    owner: { login: 'mockuser' },
    private: true,
    description: '',
    clone_url: 'https://github.com/mockuser/secret.git',
    ssh_url: 'git@github.com:mockuser/secret.git',
    html_url: 'https://github.com/mockuser/secret',
    default_branch: 'main',
    updated_at: '2026-01-02T00:00:00Z',
  },
];

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  const authed = token === GOOD_TOKEN;

  if (url.pathname === '/user' && req.method === 'GET') {
    if (!authed) return send(res, 401, { message: 'Bad credentials' });
    return send(res, 200, USER);
  }

  if (url.pathname === '/user/repos' && req.method === 'GET') {
    if (!authed) return send(res, 401, { message: 'Bad credentials' });
    return send(res, 200, REPOS);
  }

  if (url.pathname === '/user/repos' && req.method === 'POST') {
    if (!authed) return send(res, 401, { message: 'Bad credentials' });
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      let body = {};
      try { body = JSON.parse(raw || '{}'); } catch { /* ignore */ }
      if (body.name === 'taken') return send(res, 422, { message: 'name already exists' });
      send(res, 201, {
        full_name: `mockuser/${body.name}`,
        name: body.name,
        owner: { login: 'mockuser' },
        private: Boolean(body.private),
        clone_url: `https://github.com/mockuser/${body.name}.git`,
        ssh_url: `git@github.com:mockuser/${body.name}.git`,
        html_url: `https://github.com/mockuser/${body.name}`,
        default_branch: 'main',
      });
    });
    return undefined;
  }

  return send(res, 404, { message: 'Not Found' });
});

server.listen(Number(process.env.MOCK_PORT) || 0, '127.0.0.1', () => {
  process.stdout.write(`LISTENING ${server.address().port}\n`);
});

process.on('SIGTERM', () => server.close(() => process.exit(0)));
process.on('SIGINT', () => server.close(() => process.exit(0)));
