/**
 * 前端 common.js 弹窗行为单测（最小 DOM stub，node:test，无外部依赖）。
 *
 * 覆盖 F-02：会话过期时 closeAllModals() 必须关闭全部弹窗（含 confirmDialog），
 * 使确认框 Promise 正常 resolve(false)，不残留 body.modal-open 滚动锁 / keydown 监听，
 * 同时保留关闭动画（遮罩 180ms 后再移除）。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

class FakeClassList {
  constructor() {
    this.tokens = new Set();
  }
  add(...names) {
    for (const name of names) this.tokens.add(String(name));
  }
  remove(...names) {
    for (const name of names) this.tokens.delete(String(name));
  }
  contains(name) {
    return this.tokens.has(String(name));
  }
  toggle(name, force) {
    const enabled = force === undefined ? !this.contains(name) : Boolean(force);
    if (enabled) this.add(name);
    else this.remove(name);
    return enabled;
  }
}

class FakeNode {
  constructor(tagName = 'div') {
    this.nodeType = 1;
    this.tagName = String(tagName).toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.attributes = new Map();
    this.dataset = {};
    this.style = {};
    this.classList = new FakeClassList();
    this.listeners = new Map();
    this.textContent = '';
    this.className = '';
    this.hidden = false;
    this.disabled = false;
    this.value = '';
    this.isConnected = false;
  }
  get firstChild() {
    return this.children[0] ?? null;
  }
  append(...nodes) {
    for (const node of nodes.flat(Infinity)) {
      const child = node instanceof FakeNode ? node : new FakeTextNode(String(node));
      child.parentNode = this;
      child.isConnected = true;
      this.children.push(child);
    }
  }
  appendChild(node) {
    this.append(node);
    return node;
  }
  removeChild(node) {
    const index = this.children.indexOf(node);
    if (index >= 0) this.children.splice(index, 1);
    node.parentNode = null;
    node.isConnected = false;
    return node;
  }
  remove() {
    if (this.parentNode) this.parentNode.removeChild(this);
  }
  setAttribute(name, value) {
    this.attributes.set(String(name), String(value));
  }
  getAttribute(name) {
    return this.attributes.has(String(name)) ? this.attributes.get(String(name)) : null;
  }
  removeAttribute(name) {
    this.attributes.delete(String(name));
  }
  addEventListener(type, handler) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(handler);
  }
  removeEventListener(type, handler) {
    this.listeners.get(type)?.delete(handler);
  }
  querySelector() {
    return null;
  }
  querySelectorAll() {
    return [];
  }
  focus() {
    fakeDocument.activeElement = this;
  }
}

class FakeTextNode extends FakeNode {
  constructor(text) {
    super('#text');
    this.nodeType = 3;
    this.textContent = String(text);
  }
}

const documentListeners = new Map();
const fakeDocument = {
  activeElement: null,
  body: new FakeNode('body'),
  createElement(tagName) {
    return new FakeNode(tagName);
  },
  createTextNode(text) {
    return new FakeTextNode(text);
  },
  addEventListener(type, handler) {
    if (!documentListeners.has(type)) documentListeners.set(type, new Set());
    documentListeners.get(type).add(handler);
  },
  removeEventListener(type, handler) {
    documentListeners.get(type)?.delete(handler);
  },
  querySelector() {
    return null;
  },
  querySelectorAll() {
    return [];
  },
};
fakeDocument.body.isConnected = true;

globalThis.Node = FakeNode;
globalThis.document = fakeDocument;
globalThis.requestAnimationFrame = (callback) => {
  callback();
  return 1;
};

const { closeAllModals, confirmDialog, openModal } = await import('../../web/assets/common.js');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function countDocumentListeners(type) {
  return documentListeners.get(type)?.size ?? 0;
}

function backdrops() {
  // el() 的 class 属性走 node.className（非 classList），这里按 className 过滤遮罩节点
  return fakeDocument.body.children.filter((node) => String(node.className).split(/\s+/).includes('modal-backdrop'));
}

test('openModal/close：弹窗计数由活动集合派生，最后一个关闭才释放 modal-open 滚动锁', async () => {
  const first = openModal({ title: '第一层' });
  const second = openModal({ title: '第二层' });
  assert.equal(fakeDocument.body.classList.contains('modal-open'), true, '打开弹窗应加滚动锁');
  first.close('dismiss');
  assert.equal(fakeDocument.body.classList.contains('modal-open'), true, '仍有弹窗打开时保持滚动锁');
  second.close('dismiss');
  assert.equal(fakeDocument.body.classList.contains('modal-open'), false, '最后一个弹窗关闭后释放滚动锁');
  // 重复 close 幂等：不会二次扣减计数或误删滚动锁
  first.close('dismiss');
  second.close('dismiss');
  assert.equal(fakeDocument.body.classList.contains('modal-open'), false);
  await sleep(240);
});

test('closeAllModals：关闭全部弹窗（含 confirmDialog），Promise 正常 resolve 且监听/滚动锁清理', async () => {
  const trigger = new FakeNode('button');
  trigger.isConnected = true;
  fakeDocument.activeElement = trigger;

  const closed = [];
  openModal({ title: '弹窗A', onClose: (result) => closed.push(`A:${result}`) });
  openModal({ title: '弹窗B', onClose: (result) => closed.push(`B:${result}`) });
  const confirmed = confirmDialog({ title: '确认删除', message: '确定删除？' });

  assert.equal(backdrops().length, 3, '应同时存在 2 个普通弹窗 + 1 个确认弹窗');
  assert.equal(countDocumentListeners('keydown'), 3, '每个弹窗注册一个 keydown 监听');

  closeAllModals('unauthorized');

  // confirmDialog 的 Promise 必须被 resolve，而不是因会话过期永久悬挂
  assert.equal(await confirmed, false, '会话过期时确认框 Promise 应 resolve(false)');
  assert.deepEqual(closed.sort(), ['A:unauthorized', 'B:unauthorized'], '各弹窗 onClose 应各触发一次');
  assert.equal(fakeDocument.body.classList.contains('modal-open'), false, '滚动锁应释放');
  assert.equal(countDocumentListeners('keydown'), 0, 'keydown 监听应全部注销');
  assert.equal(fakeDocument.activeElement, trigger, '关闭后应恢复原焦点');
  // 关闭动画保留：遮罩在 180ms 后才移除，closeAllModals 不手工 remove DOM
  assert.equal(backdrops().length, 3, '关闭动画期间遮罩仍在 DOM 中');
  await sleep(240);
  assert.equal(backdrops().length, 0, '动画结束后遮罩应移除');
  // 重复调用安全且不重复触发 onClose
  closeAllModals();
  assert.equal(closed.length, 2);
});

test('openModal：背景顶层节点设置 inert/aria-hidden，最后一个弹窗关闭后恢复（F-06）', async () => {
  const shell = new FakeNode('main');
  shell.setAttribute('aria-hidden', 'false');
  fakeDocument.body.append(shell);

  const first = openModal({ title: '第一层' });
  assert.equal(shell.inert, true, '打开弹窗时背景节点应 inert');
  assert.equal(shell.getAttribute('aria-hidden'), 'true', '背景节点应设置 aria-hidden');

  const second = openModal({ title: '第二层' });
  first.close('dismiss');
  assert.equal(shell.inert, true, '仍有弹窗打开时背景应保持 inert');

  second.close('dismiss');
  assert.equal(shell.inert, false, '最后一个弹窗关闭后应移除 inert');
  assert.equal(shell.getAttribute('aria-hidden'), 'false', '应恢复原有 aria-hidden 值');

  await sleep(240);
  shell.remove();
});

test('openModal：Tab 键被焦点陷阱拦截且不逃逸到背景（F-06）', async () => {
  const modal = openModal({ title: '焦点陷阱' });
  let prevented = false;
  const event = {
    key: 'Tab',
    shiftKey: false,
    shift: false,
    preventDefault() {
      prevented = true;
    },
  };
  for (const handler of documentListeners.get('keydown') ?? []) handler(event);
  assert.equal(prevented, true, '无可聚焦元素时应阻止 Tab 默认跳转');
  assert.equal(fakeDocument.activeElement, modal.dialog, '焦点应留在 dialog 上');
  modal.close('dismiss');
  await sleep(240);
});
