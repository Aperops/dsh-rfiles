/**
 * 测试目录入口。
 *
 * 本机 Node 构建（v22.23.3）的 `node --test` 不接受“目录”作为参数：
 * 它会把 `test/` 当成一个测试文件去加载，于是报 MODULE_NOT_FOUND。
 * 这里提供一个目录入口，让验收命令 `node --test test/` 能正常展开测试：
 * Node 会把它当普通测试文件执行，其中的 import 会注册所有测试。
 *
 * 直接用 `node --test`（自动发现）或 `node --test test/core.test.mjs` 也可以，
 * 且不会重复执行（ESM 模块缓存保证只执行一次）。
 */
import './core.test.mjs'
import './routes.test.mjs'
