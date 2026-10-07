/**
 * Manifest and artifact contract: the package has to declare itself the way the
 * Harness loader and dsh-client-modules expect, and the built bundle has to be
 * the lazy-CJS factory the page's module table calls.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const root = new URL('../', import.meta.url)
const read = (path) => readFileSync(fileURLToPath(new URL(path, root)), 'utf8')
const pkg = JSON.parse(read('package.json'))

test('包名、版本与运行时报告的版本一致', () => {
  assert.equal(pkg.name, 'dsh-alerts')
  const version = /export const VERSION = '([^']+)'/.exec(read('src/version.ts'))?.[1]
  assert.equal(version, pkg.version, 'src/version.ts 要与 package.json 同步（release 检查）')
})

test('bundle 补丁存在，且插入的就是本插件的条目', () => {
  const patch = read('cordis.patch.yml')
  assert.match(patch, /insert:/)
  assert.match(patch, /id: dsh-alerts/)
  assert.match(patch, /name: 'dsh-alerts'/)
  assert.equal(pkg.dsh?.bundle?.patch, './cordis.patch.yml')
})

test('客户端声明：web 平台、声明注入的宿主包、入口指向构建产物', () => {
  assert.equal(pkg.dsh?.client?.platform, 'web')
  assert.ok(Array.isArray(pkg.dsh?.client?.inject) && pkg.dsh.client.inject.length > 0)
  assert.equal(pkg.exports['./client'], './lib/client.js')
})

test('构建产物是 __ModuleLoader__ 的懒执行工厂', () => {
  const bundle = read('lib/client.js')
  assert.match(bundle, /^window\.__ModuleLoader__\.load\(\{/)
  assert.match(bundle, /id: "dsh-alerts"/)
  assert.match(bundle, /factory: \(require\) => \{/)
  assert.match(bundle, /exports\.apply = apply;/)
  assert.match(bundle, /exports\.inject = inject;/)
  assert.ok(bundle.trimEnd().endsWith('});'), '工厂必须以 load(...) 收尾')
  assert.equal(bundle.includes('import '), false, '浏览器产物里不该残留 ESM 语法')
})

test('发布内容包含运行所需的一切', () => {
  for (const file of ['lib/index.js', 'lib/client.js', 'cordis.patch.yml', 'README.md', 'LICENSE']) {
    assert.ok(existsSync(fileURLToPath(new URL(file, root))), `${file} 应当存在`)
  }
  assert.ok(pkg.files.includes('lib/client.js') || pkg.files.includes('lib'), 'files 要带上构建产物')
})
