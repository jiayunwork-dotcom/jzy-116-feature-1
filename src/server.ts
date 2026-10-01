import { createApp } from './app.js';

const port = Number(process.env.PORT ?? 8080);

const server = createApp().listen(port, () => {
  // PORT=0 时由操作系统分配临时端口，日志必须报实际端口（便于测试/探活）
  const addr = server.address();
  const actualPort =
    addr && typeof addr === 'object' ? addr.port : port;
  console.log(`M/M/1/K 排队核算服务已启动，监听端口 ${actualPort}`);
});

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}
