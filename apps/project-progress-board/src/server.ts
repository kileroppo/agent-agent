import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dashboard, listProjects, getProject, createProject, updateProject, createTask, updateTask } from './store.ts';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public');
const port = Number(process.env.PORT || 4320);
const host = process.env.HOST || '0.0.0.0';
const mime: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
function json(response: any, status: any, body: any) { response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); response.end(JSON.stringify(body)); }
async function body(request: any) { let raw = ''; for await (const chunk of request)
    raw += chunk; try {
    return raw ? JSON.parse(raw) : {};
}
catch {
    throw new Error('请求数据格式无效');
} }
function route(pathname: any) { return pathname.split('/').filter(Boolean); }
const server = http.createServer(async (request: any, response: any) => {
    const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
    if (url.pathname === '/api/health')
        return json(response, 200, { ok: true, service: 'project-progress-board', port });
    if (url.pathname.startsWith('/api/')) {
        try {
            const parts = route(url.pathname);
            if (request.method === 'GET' && url.pathname === '/api/dashboard')
                return json(response, 200, dashboard());
            if (request.method === 'GET' && url.pathname === '/api/projects')
                return json(response, 200, { projects: listProjects() });
            if (request.method === 'GET' && parts[1] === 'projects' && parts[2]) {
                const project = getProject(parts[2]);
                return project ? json(response, 200, { project }) : json(response, 404, { error: '项目不存在' });
            }
            if (request.method === 'POST' && url.pathname === '/api/projects')
                return json(response, 201, { project: createProject(await body(request)) });
            if (request.method === 'PATCH' && parts[1] === 'projects' && parts[2]) {
                const project = updateProject(parts[2], await body(request));
                return project ? json(response, 200, { project }) : json(response, 404, { error: '项目不存在' });
            }
            if (request.method === 'POST' && parts[1] === 'projects' && parts[2] && parts[3] === 'tasks') {
                const task = createTask(parts[2], await body(request));
                return task ? json(response, 201, { task }) : json(response, 404, { error: '项目不存在' });
            }
            if (request.method === 'PATCH' && parts[1] === 'tasks' && parts[2]) {
                const task = updateTask(parts[2], await body(request));
                return task ? json(response, 200, { task }) : json(response, 404, { error: '任务不存在' });
            }
            return json(response, 404, { error: '接口不存在' });
        }
        catch (error) {
            return json(response, 400, { error: (error as Error).message || '请求失败' });
        }
    }
    const requested = url.pathname === '/' ? '/index.html' : url.pathname;
    const file = path.resolve(root, `.${requested}`);
    if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory())
        return json(response, 404, { error: '页面不存在' });
    response.writeHead(200, { 'Content-Type': mime[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(response);
});
server.listen(port, host, () => console.log(`Project progress board listening on http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${port}`));
