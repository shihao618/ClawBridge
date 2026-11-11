/**
 * 微信（ClawBot）Markdown 兼容过滤器 —— 发送前把微信不渲染的语法清理掉。
 *
 * 逻辑移植自腾讯官方微信插件 `@tencent-weixin/openclaw-weixin@2.4.10`
 * 的 `dist/src/messaging/markdown-filter.js`（MIT License，Copyright Tencent）。
 * 官方插件在**所有出站文本**上应用同一过滤器，本模块保持逐字符状态机语义一致，
 * 仅增加一次性便捷函数 `filterWechatMarkdown()`。
 *
 * 微信客户端保留（会渲染/原样传递）：
 * - 代码块（围栏）、行内代码、表格、水平线
 * - 粗体、非中文内容的斜体与粗斜体
 * - 标题 H1–H4、引用、有序/无序列表
 * 微信不渲染（过滤处理）：
 * - 中文内容的斜体/粗斜体（去掉 * 或 _ 标记，保留文字）
 * - H5/H6 标题（去掉 ##### / ###### 与空格，保留文字）
 * - 图片（整段移除）
 *
 * 预览端（web/assets/lib/wechat-markdown.js）使用同一实现，并由单测做逐例一致性校验；
 * 兼容性文档见 docs/MARKDOWN_WECHAT.md。
 */

/** 微信渲染器对 CJK 内容不处理斜体，因此过滤时只去掉标记。 */
const CJK_RE = /[\u2E80-\u9FFF\uAC00-\uD7AF\uF900-\uFAFF]/;

function containsCJK(text) {
  return CJK_RE.test(text);
}

/** 逐字符流式过滤器（与官方插件同语义，便于与其它流式文本管道对齐）。 */
export class StreamingWechatMarkdownFilter {
  constructor() {
    this.buf = '';
    this.fence = false;
    /** 围栏标记字符：` 或 ~（CommonMark 两种围栏都支持；~ 不作为删除线标记处理）。 */
    this.fenceChar = '`';
    this.sol = true;
    this.inl = null;
  }

  feed(delta) {
    this.buf += String(delta ?? '');
    return this.pump(false);
  }

  flush() {
    return this.pump(true);
  }

  pump(eof) {
    let out = '';
    while (this.buf) {
      const sLen = this.buf.length;
      const sSol = this.sol;
      const sFence = this.fence;
      const sInl = this.inl;
      if (this.fence) out += this.pumpFence(eof);
      else if (this.inl) out += this.pumpInline(eof);
      else if (this.sol) out += this.pumpSOL(eof);
      else out += this.pumpBody(eof);
      if (this.buf.length === sLen && this.sol === sSol && this.fence === sFence && this.inl === sInl) break;
    }
    if (eof && this.inl) {
      const markers = { image: '![', bold3: '***', italic: '*', ubold3: '___', uitalic: '_' };
      out += (markers[this.inl.type] ?? '') + this.inl.acc;
      this.inl = null;
    }
    return out;
  }

  /** 代码块内：原样传递（含围栏标记；``` 与 ~~~ 均支持）。 */
  pumpFence(eof) {
    if (this.sol) {
      if (this.buf.length < 3 && !eof) return '';
      const fenceMarker = String(this.fenceChar ?? '`').repeat(3);
      if (this.buf.startsWith(fenceMarker)) {
        const nl = this.buf.indexOf('\n', 3);
        if (nl !== -1) {
          this.fence = false;
          this.fenceChar = '`';
          const line = this.buf.slice(0, nl + 1);
          this.buf = this.buf.slice(nl + 1);
          this.sol = true;
          return line;
        }
        if (eof) {
          this.fence = false;
          this.fenceChar = '`';
          const line = this.buf;
          this.buf = '';
          return line;
        }
        return '';
      }
      this.sol = false;
    }
    const nl = this.buf.indexOf('\n');
    if (nl !== -1) {
      const chunk = this.buf.slice(0, nl + 1);
      this.buf = this.buf.slice(nl + 1);
      this.sol = true;
      return chunk;
    }
    const chunk = this.buf;
    this.buf = '';
    return chunk;
  }

  /** 行首：识别围栏/引用/H5-H6/水平线等行级模式。 */
  pumpSOL(eof) {
    const b = this.buf;
    if (b[0] === '\n') {
      this.buf = b.slice(1);
      return '\n';
    }
    if (b[0] === '`') {
      if (b.length < 3 && !eof) return '';
      if (b.startsWith('```')) {
        const nl = b.indexOf('\n', 3);
        if (nl !== -1) {
          this.fence = true;
          this.fenceChar = '`';
          const line = b.slice(0, nl + 1);
          this.buf = b.slice(nl + 1);
          this.sol = true;
          return line;
        }
        if (eof) {
          this.buf = '';
          return b;
        }
        return '';
      }
      this.sol = false;
      return '';
    }
    if (b[0] === '~') {
      // `~~~` 围栏（CommonMark）原样保留；行内/普通 `~` 仍按“删除线标记丢弃”处理。
      if (b.length < 3 && !eof) return '';
      if (b.startsWith('~~~')) {
        const nl = b.indexOf('\n', 3);
        if (nl !== -1) {
          this.fence = true;
          this.fenceChar = '~';
          const line = b.slice(0, nl + 1);
          this.buf = b.slice(nl + 1);
          this.sol = true;
          return line;
        }
        if (eof) {
          this.buf = '';
          return b;
        }
        return '';
      }
      this.sol = false;
      return '';
    }
    if (b[0] === '>') {
      this.sol = false;
      return '';
    }
    if (b[0] === '#') {
      let n = 0;
      while (n < b.length && b[n] === '#') n += 1;
      if (n === b.length && !eof) return '';
      if (n >= 5 && n <= 6 && n < b.length && b[n] === ' ') {
        this.buf = b.slice(n + 1);
        this.sol = false;
        return '';
      }
      this.sol = false;
      return '';
    }
    if (b[0] === ' ' || b[0] === '\t') {
      if (b.search(/[^ \t]/) === -1 && !eof) return '';
      this.sol = false;
      return '';
    }
    if (b[0] === '-' || b[0] === '*' || b[0] === '_') {
      const ch = b[0];
      let j = 0;
      while (j < b.length && (b[j] === ch || b[j] === ' ')) j += 1;
      if (j === b.length && !eof) return '';
      if (j === b.length || b[j] === '\n') {
        let count = 0;
        for (let k = 0; k < j; k += 1) if (b[k] === ch) count += 1;
        if (count >= 3) {
          if (j < b.length) {
            this.buf = b.slice(j + 1);
            this.sol = true;
            return b.slice(0, j + 1);
          }
          this.buf = '';
          return b;
        }
      }
      this.sol = false;
      return '';
    }
    this.sol = false;
    return '';
  }

  /** 行内扫描：输出安全字符，遇到潜在标记时进入内联累积状态。 */
  pumpBody(eof) {
    let out = '';
    let i = 0;
    while (i < this.buf.length) {
      const c = this.buf[i];
      if (c === '\n') {
        out += this.buf.slice(0, i + 1);
        this.buf = this.buf.slice(i + 1);
        this.sol = true;
        return out;
      }
      if (c === '!' && i + 1 < this.buf.length && this.buf[i + 1] === '[') {
        out += this.buf.slice(0, i);
        this.buf = this.buf.slice(i + 2);
        this.inl = { type: 'image', acc: '' };
        return out;
      }
      if (c === '~') {
        // 官方 markdown-filter.js 的 `~` 分支语义为“丢弃删除线标记、保留文字”（微信不渲染删除线）；
        // 官方流式实现的跳过分支未回写 out，实际会保留 ~ 字符（实现 bug）。这里按官方意图真正丢弃标记，
        // 保证发送文本与文档“删除线不在支持列表、仅保留文字”一致。
        out += this.buf.slice(0, i);
        this.buf = this.buf.slice(i + 1);
        return out;
      }
      if (c === '*') {
        if (i + 2 < this.buf.length && this.buf[i + 1] === '*' && this.buf[i + 2] === '*') {
          out += this.buf.slice(0, i);
          this.buf = this.buf.slice(i + 3);
          this.inl = { type: 'bold3', acc: '' };
          return out;
        }
        if (i + 1 < this.buf.length && this.buf[i + 1] === '*') {
          i += 2;
          continue;
        }
        if (i + 1 < this.buf.length && this.buf[i + 1] !== ' ' && this.buf[i + 1] !== '\n') {
          out += this.buf.slice(0, i);
          this.buf = this.buf.slice(i + 1);
          this.inl = { type: 'italic', acc: '' };
          return out;
        }
        i += 1;
        continue;
      }
      if (c === '_') {
        if (i + 2 < this.buf.length && this.buf[i + 1] === '_' && this.buf[i + 2] === '_') {
          out += this.buf.slice(0, i);
          this.buf = this.buf.slice(i + 3);
          this.inl = { type: 'ubold3', acc: '' };
          return out;
        }
        if (i + 1 < this.buf.length && this.buf[i + 1] === '_') {
          i += 2;
          continue;
        }
        if (i + 1 < this.buf.length && this.buf[i + 1] !== ' ' && this.buf[i + 1] !== '\n') {
          out += this.buf.slice(0, i);
          this.buf = this.buf.slice(i + 1);
          this.inl = { type: 'uitalic', acc: '' };
          return out;
        }
        i += 1;
        continue;
      }
      i += 1;
    }
    let hold = 0;
    if (!eof) {
      if (this.buf.endsWith('**')) hold = 2;
      else if (this.buf.endsWith('__')) hold = 2;
      else if (this.buf.endsWith('*')) hold = 1;
      else if (this.buf.endsWith('_')) hold = 1;
      else if (this.buf.endsWith('!')) hold = 1;
    }
    out += this.buf.slice(0, this.buf.length - hold);
    this.buf = hold > 0 ? this.buf.slice(-hold) : '';
    return out;
  }

  /** 内联累积：等待闭合标记后决定保留/去标记/删除。 */
  pumpInline() {
    if (!this.inl) return '';
    this.inl.acc += this.buf;
    this.buf = '';
    if (this.inl.type === 'bold3') {
      const idx = this.inl.acc.indexOf('***');
      if (idx !== -1) {
        const content = this.inl.acc.slice(0, idx);
        this.buf = this.inl.acc.slice(idx + 3);
        this.inl = null;
        return containsCJK(content) ? content : `***${content}***`;
      }
      return '';
    }
    if (this.inl.type === 'ubold3') {
      const idx = this.inl.acc.indexOf('___');
      if (idx !== -1) {
        const content = this.inl.acc.slice(0, idx);
        this.buf = this.inl.acc.slice(idx + 3);
        this.inl = null;
        return containsCJK(content) ? content : `___${content}___`;
      }
      return '';
    }
    if (this.inl.type === 'italic' || this.inl.type === 'uitalic') {
      const marker = this.inl.type === 'italic' ? '*' : '_';
      for (let j = 0; j < this.inl.acc.length; j += 1) {
        if (this.inl.acc[j] === '\n') {
          const r = marker + this.inl.acc.slice(0, j + 1);
          this.buf = this.inl.acc.slice(j + 1);
          this.inl = null;
          this.sol = true;
          return r;
        }
        if (this.inl.acc[j] === marker) {
          if (j + 1 < this.inl.acc.length && this.inl.acc[j + 1] === marker) {
            j += 1;
            continue;
          }
          const content = this.inl.acc.slice(0, j);
          this.buf = this.inl.acc.slice(j + 1);
          this.inl = null;
          return containsCJK(content) ? content : `${marker}${content}${marker}`;
        }
      }
      return '';
    }
    if (this.inl.type === 'image') {
      const cb = this.inl.acc.indexOf(']');
      if (cb === -1) return '';
      if (cb + 1 >= this.inl.acc.length) return '';
      if (this.inl.acc[cb + 1] !== '(') {
        const r = `![${this.inl.acc.slice(0, cb + 1)}`;
        this.buf = this.inl.acc.slice(cb + 1);
        this.inl = null;
        return r;
      }
      const cp = this.inl.acc.indexOf(')', cb + 2);
      if (cp !== -1) {
        this.buf = this.inl.acc.slice(cp + 1);
        this.inl = null;
        return '';
      }
      return '';
    }
    return '';
  }
}

/** 一次性过滤：返回微信可渲染的文本（与官方插件对整段文本 feed+flush 等价）。 */
export function filterWechatMarkdown(text) {
  const filter = new StreamingWechatMarkdownFilter();
  return filter.feed(String(text ?? '').replace(/\r\n?/g, '\n')) + filter.flush();
}

/** 列表项行（有序/无序，允许 0–3 空格缩进）。 */
function isListItemLine(line) {
  return /^\s{0,3}([-*+]|\d{1,9}[.)])(\s+|$)/.test(line);
}

/** 表格行（以 | 开头/结尾或含分隔行特征）。 */
function isTableLine(line) {
  const trimmed = line.trim();
  if (trimmed === '') return false;
  if (trimmed.startsWith('|') || trimmed.endsWith('|')) return true;
  return /^\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)+\|?$/.test(trimmed);
}

/** 缩进代码块行（>=4 空格）。 */
function isIndentedCodeLine(line) {
  return /^\s{4,}\S/.test(line);
}

/**
 * 微信文本换行布局（兼容保留，不再用于出站发送/预览）。
 *
 * 官方插件不修改换行，ClawBridge 现已对齐：`formatWeixinText` / 模板预览只做 Markdown 过滤，
 * 原样保留模板换行；本函数仅保留给历史调用/兼容测试，避免旧代码引用报错。
 */
export function layoutWechatText(text) {
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let fenceChar = null;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const trimmed = line.trim();
    const fence = /^(`{3,}|~{3,})/.exec(trimmed);
    if (fence) {
      if (fenceChar === null) fenceChar = fence[1][0];
      else if (fence[1][0] === fenceChar) fenceChar = null;
      out.push(line);
      continue;
    }
    if (fenceChar !== null) {
      out.push(line);
      continue;
    }
    out.push(line);
    if (index === lines.length - 1) continue;
    const next = lines[index + 1];
    if (trimmed === '' || next.trim() === '') continue;
    // 保持块结构：列表项之间、表格行之间、缩进代码块之间、列表项缩进续行之间不插空行；
    // 普通文本后紧跟列表时也不插空行（标题/说明贴着自己的列表，避免多余空行）。
    if (isListItemLine(line) && isListItemLine(next)) continue;
    if (!isListItemLine(line) && isListItemLine(next)) continue;
    if (isTableLine(line) && isTableLine(next)) continue;
    if (isIndentedCodeLine(line) && isIndentedCodeLine(next)) continue;
    if (isListItemLine(line) && /^\s+\S/.test(next)) continue;
    out.push('');
  }
  return out.join('\n');
}

/** 分析一段 Markdown 会被微信规则做哪些调整（用于后台预览提示，不参与发送）。 */
export function describeWechatMarkdownAdjustments(text) {
  const raw = String(text ?? '');
  const stripped = raw
    .replace(/```[\s\S]*?```/g, '')
    .replace(/`[^`\n]*`/g, '');
  const result = { images: 0, cjkItalic: 0, h5h6: 0 };
  result.images = (stripped.match(/!\[[^\]]*\]\([^)]*\)/g) ?? []).length;
  result.h5h6 = stripped.split('\n').filter((line) => /^\s*#{5,6}\s/.test(line)).length;
  // 仅统计微信不渲染的中文斜体/粗斜体（单 * 或 _、三连 *** / ___）；** 与 __ 粗体保留
  const cjkItalicRe = /(?<![*_])(\*{3}|_{3}|\*|_)([^*_\n]*[\u2E80-\u9FFF][^*_\n]*)\1(?![*_])/g;
  result.cjkItalic = (stripped.match(cjkItalicRe) ?? []).length;
  return result;
}

/** 兼容性规则摘要（供帮助弹窗/预览提示复用）。 */
export const WECHAT_MARKDOWN_SUPPORT = Object.freeze({
  // 官方 StreamingMarkdownFilter 不渲染删除线（`~` 字符直接丢弃、保留文字），因此不能列为 supported。
  supported: ['代码块', '行内代码', '表格', '水平线', '粗体', '标题 H1–H4', '引用', '列表', '非中文斜体'],
  filtered: ['中文斜体（去标记）', 'H5/H6 标题（去 #）', '图片（整段移除）', '删除线（去标记，保留文字）'],
});
