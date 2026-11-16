/**
 * dsh-vision-direct — browser half.
 *
 * 一个「视觉模型」设置页（slot `settings.section`），视觉语言对齐
 * dsh-our-free-model：毛玻璃卡片、取宿主 --dsw-alias-* 令牌、昼夜随宿主切换。
 *
 * 页面只做四件事：
 *   1. 选协议（OpenAI / Anthropic）与预设上游；
 *   2. 填 baseUrl / model / key / 额外请求头；
 *   3. 直连测试 —— 一次真图请求，直接回答「这套配置通不通」；
 *   4. 读图自检 —— 在这个页面里当场读一张图，看模型回了什么证据。
 *
 * 这里没有「应用到别的工具」：插件自己就是视觉后端，配置只写自己的文件。
 * 密钥永不由后端回传：页面只有 hasKey 与 keyPreview，提交空值表示「这一格没改」，
 * 所以浏览器里不存在明文，也不会把旧值误写回。
 */
window.__ModuleLoader__.load({
  id: 'dsh-vision-direct',
  factory: require => {
    const module = { exports: {} }
    const exports = module.exports
    const React = require('react')
    const { createElement: h, Fragment, useState, useEffect, useMemo, useCallback } = React

    const inject = ['slots']

    // 相对页面 base 解析：宿主挂在反向代理子路径下时，前导斜杠会丢前缀。
    // 解析不了就退回根路径。
    const API = (() => {
      try { return new URL('api/vision', document.baseURI).pathname } catch { return '/api/vision' }
    })()

    /**
     * 统一请求入口。后端路由的响应体就是 handler 返回的对象本身，没有包一层
     * `{ data: ... }`，所以这里直接把 JSON.parse 的结果交给调用方——
     * 调用方拿到的 `payload` 就是后端返回的那个对象。
     *
     * 由此推出一条读代码时的注意点：**列表类字段要按字段名取，不能把 payload
     * 当数组**。后端约定列表一律包成对象（如 `{ models: [...] }`），
     * 判断写成 `Array.isArray(payload?.models)`；如果哪天后端改回裸数组，
     * 这里不会抛错，只会静默拿到空列表。新增路由时两边必须同时对齐。
     */
    async function api(path, options) {
      const { timeout = 120_000, ...rest } = options ?? {}
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), timeout)
      try {
        const response = await fetch(`${API}${path}`, { ...rest, redirect: 'error', signal: ctrl.signal })
        const text = await response.text()
        let payload
        try { payload = text === '' ? {} : JSON.parse(text) } catch { payload = { error: text.slice(0, 300) } }
        if (!response.ok) throw new Error(payload?.error ?? `HTTP ${response.status}`)
        return payload
      } catch (error) {
        if (error?.name === 'AbortError') throw new Error(`请求超过 ${Math.round(timeout / 1000)} 秒未返回`)
        throw error
      } finally { clearTimeout(timer) }
    }
    const get = path => api(path)
    const post = (path, body, timeout) => api(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body ?? {}),
      ...(timeout === undefined ? {} : { timeout }),
    })

    // ── styles ────────────────────────────────────────────────────────────────
    const CSS = `
.vg_root{--vg-ease:cubic-bezier(.16,1,.3,1);display:flex;flex-direction:column;gap:16px;max-width:1040px;font-size:13px;line-height:1.55;color:var(--dsw-alias-label-primary);-webkit-font-smoothing:antialiased}
.vg_root *{box-sizing:border-box}
.vg_root ::selection{background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 24%,transparent)}
.vg_root :focus-visible{outline:2px solid color-mix(in srgb,var(--dsw-alias-state-business-primary) 78%,transparent);outline-offset:2px;box-shadow:0 0 0 4px color-mix(in srgb,var(--dsw-alias-state-business-primary) 13%,transparent)}
.vg_mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-variant-numeric:tabular-nums}

.vg_hero{position:relative;display:flex;flex-direction:column;gap:14px;padding:22px 24px;border-radius:20px;border:1px solid color-mix(in srgb,var(--dsw-alias-border-l2) 78%,transparent);background:linear-gradient(165deg,color-mix(in srgb,var(--dsw-alias-bg-layer-3) 88%,transparent),color-mix(in srgb,var(--dsw-alias-bg-layer-1) 82%,transparent));overflow:hidden}
.vg_hero::before{content:"";position:absolute;inset:0;pointer-events:none;background:radial-gradient(120% 150% at 12% -20%,color-mix(in srgb,var(--dsw-alias-state-business-primary) 13%,transparent),transparent 58%),radial-gradient(90% 120% at 88% 130%,color-mix(in srgb,var(--dsw-alias-state-success-primary) 7%,transparent),transparent 60%)}
.vg_hero>*{position:relative}
.vg_head{display:flex;align-items:flex-end;gap:14px;flex-wrap:wrap}
.vg_title{display:flex;flex-direction:column;gap:6px;min-width:0}
.vg_title h2{margin:0;font-size:23px;font-weight:760;letter-spacing:-.6px;line-height:1.2;background:linear-gradient(120deg,var(--dsw-alias-label-primary) 20%,color-mix(in srgb,var(--dsw-alias-label-primary) 55%,var(--dsw-alias-state-business-primary)));-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent}
.vg_sub{margin:0;font-size:12.5px;color:var(--dsw-alias-label-secondary);max-width:74ch}
.vg_pills{display:flex;gap:6px;flex-wrap:wrap;margin-left:auto}
.vg_pill{display:inline-flex;align-items:center;gap:6px;padding:3px 10px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1);background:color-mix(in srgb,var(--dsw-alias-bg-layer-2) 78%,transparent);box-shadow:inset 0 1px 0 rgb(255 255 255 / 4%);font-size:11.5px;color:var(--dsw-alias-label-secondary);white-space:nowrap}
.vg_dot{width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-label-tertiary);flex:none}
@keyframes vg-breathe{0%,100%{opacity:1}50%{opacity:.5}}
.vg_dot.ok{background:var(--dsw-alias-state-success-primary);box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-state-success-primary) 18%,transparent);animation:vg-breathe 2.6s ease-in-out infinite}
.vg_dot.warn{background:var(--dsw-alias-state-warning-primary,#f0a441);box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-state-warning-primary,#f0a441) 18%,transparent)}

.vg_sec{display:flex;flex-direction:column;gap:10px}
.vg_sechead{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;padding-bottom:6px;border-bottom:1px solid var(--dsw-alias-border-l1)}
.vg_sectitle{font-size:14px;font-weight:680;letter-spacing:-.2px}
.vg_sechint{font-size:11.5px;color:var(--dsw-alias-label-tertiary);margin-left:auto}
.vg_panel{padding:16px;border-radius:16px;border:1px solid var(--dsw-alias-border-l2);background:color-mix(in srgb,var(--dsw-alias-bg-layer-2) 82%,transparent);box-shadow:inset 0 1px 0 rgb(255 255 255 / 5%),0 2px 6px rgb(0 0 0 / 4%);display:flex;flex-direction:column;gap:12px}
.vg_ptitle{display:flex;align-items:center;gap:8px;font-size:12px;font-weight:680;letter-spacing:.2px;color:var(--dsw-alias-label-secondary)}
.vg_phint{margin-left:auto;font-size:11px;font-weight:400;color:var(--dsw-alias-label-tertiary)}

.vg_seg{display:inline-flex;padding:3px;border-radius:10px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);gap:2px;box-shadow:inset 0 1px 2px rgb(0 0 0 / 5%)}
.vg_seg button{border:0;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:11.5px;font-weight:550;padding:4px 13px;border-radius:8px;cursor:pointer;transition:color .16s ease,background .16s ease,box-shadow .16s ease}
.vg_seg button:hover{color:var(--dsw-alias-label-primary)}
.vg_seg button[aria-pressed="true"]{background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);box-shadow:0 1px 3px rgb(0 0 0 / 12%),inset 0 1px 0 rgb(255 255 255 / 6%)}

.vg_presets{display:grid;grid-template-columns:repeat(auto-fill,minmax(196px,1fr));gap:9px}
.vg_preset{position:relative;display:flex;flex-direction:column;gap:5px;padding:11px 12px;border-radius:12px;border:1px solid var(--dsw-alias-border-l2);background:color-mix(in srgb,var(--dsw-alias-bg-layer-3) 80%,transparent);box-shadow:inset 0 1px 0 rgb(255 255 255 / 6%);cursor:pointer;text-align:left;font:inherit;color:inherit;transition:transform .2s var(--vg-ease),box-shadow .24s ease,border-color .18s ease}
.vg_preset:hover{transform:translateY(-2px);border-color:color-mix(in srgb,var(--dsw-alias-state-business-primary) 66%,var(--dsw-alias-border-l2));box-shadow:inset 0 1px 0 rgb(255 255 255 / 9%),0 12px 28px color-mix(in srgb,var(--dsw-alias-state-business-primary) 11%,transparent)}
.vg_preset[aria-pressed="true"]{border-color:color-mix(in srgb,var(--dsw-alias-state-business-primary) 72%,transparent);box-shadow:inset 0 1px 0 rgb(255 255 255 / 9%),0 0 0 1px color-mix(in srgb,var(--dsw-alias-state-business-primary) 34%,transparent),0 8px 22px color-mix(in srgb,var(--dsw-alias-state-business-primary) 10%,transparent)}
.vg_presetmain{display:flex;flex-direction:column;gap:5px;padding:0;border:0;background:transparent;text-align:left;font:inherit;color:inherit;cursor:pointer;min-width:0}
.vg_presetdel{position:absolute;top:6px;right:6px;width:20px;height:20px;border-radius:6px;border:1px solid var(--dsw-alias-border-l1);background:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 82%,transparent);color:var(--dsw-alias-label-tertiary);cursor:pointer;font:inherit;font-size:12px;line-height:1;opacity:0;transition:opacity .15s ease,color .15s ease}
.vg_preset:hover .vg_presetdel,.vg_presetdel:focus-visible{opacity:1}
.vg_presetdel:hover{color:var(--dsw-alias-state-error-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 42%,transparent)}
.vg_presetname{display:flex;align-items:center;gap:7px;font-size:12.5px;font-weight:640;letter-spacing:-.1px;padding-right:20px}
.vg_presetid,.vg_preseturl{font-size:10.5px;color:var(--dsw-alias-label-tertiary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.vg_presetid{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.vg_chip{font-size:9.5px;font-weight:700;letter-spacing:.3px;padding:2px 7px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary);background:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 60%,transparent);white-space:nowrap;text-transform:uppercase}
.vg_chip.openai{color:var(--dsw-alias-state-success-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary) 45%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 10%,transparent)}
.vg_chip.anthropic{color:var(--dsw-alias-state-business-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-business-primary) 45%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 10%,transparent)}

.vg_form{display:grid;grid-template-columns:repeat(auto-fit,minmax(258px,1fr));gap:11px}
.vg_field{display:flex;flex-direction:column;gap:5px;min-width:0}
.vg_field.wide{grid-column:1/-1}
.vg_label{display:flex;align-items:center;gap:6px;font-size:11.5px;font-weight:600;color:var(--dsw-alias-label-secondary);letter-spacing:.1px}
.vg_req{color:var(--dsw-alias-state-error-primary)}
.vg_mark{margin-left:auto;font-size:10px;font-weight:600;color:var(--dsw-alias-state-success-primary)}
.vg_input{width:100%;padding:7px 10px;border-radius:9px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:12.5px;line-height:1.45;transition:border-color .16s ease,box-shadow .16s ease}
.vg_input:hover{border-color:color-mix(in srgb,var(--dsw-alias-label-tertiary) 42%,var(--dsw-alias-border-l2))}
.vg_input:focus{outline:0;border-color:color-mix(in srgb,var(--dsw-alias-state-business-primary) 66%,transparent);box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-state-business-primary) 13%,transparent)}
.vg_input::placeholder{color:var(--dsw-alias-label-tertiary);opacity:.72}
.vg_input.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px}
.vg_hint{font-size:10.5px;color:var(--dsw-alias-label-tertiary);line-height:1.5}
.vg_hint.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;word-break:break-all}

.vg_hrows{display:flex;flex-direction:column;gap:6px}
.vg_hrow{display:grid;grid-template-columns:minmax(120px,.85fr) minmax(120px,1.15fr) auto;gap:6px;align-items:center}
.vg_iconbtn{display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;border-radius:7px;border:1px solid var(--dsw-alias-border-l1);background:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 70%,transparent);color:var(--dsw-alias-label-tertiary);cursor:pointer;font:inherit;font-size:13px;line-height:1;transition:color .16s ease,border-color .16s ease}
.vg_iconbtn:hover{color:var(--dsw-alias-state-error-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 42%,transparent)}

.vg_actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.vg_btn{display:inline-flex;align-items:center;gap:6px;padding:6px 14px;border-radius:9px;border:1px solid var(--dsw-alias-border-l2);background:color-mix(in srgb,var(--dsw-alias-bg-layer-3) 82%,transparent);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;font-weight:560;cursor:pointer;box-shadow:inset 0 1px 0 rgb(255 255 255 / 6%),0 1px 2px rgb(0 0 0 / 6%);transition:transform .18s var(--vg-ease),box-shadow .2s ease,border-color .16s ease}
.vg_btn:hover:not(:disabled){transform:translateY(-1px);border-color:color-mix(in srgb,var(--dsw-alias-state-business-primary) 58%,var(--dsw-alias-border-l2));box-shadow:inset 0 1px 0 rgb(255 255 255 / 9%),0 8px 18px color-mix(in srgb,var(--dsw-alias-state-business-primary) 13%,transparent)}
.vg_btn:disabled{opacity:.5;cursor:not-allowed}
.vg_btn.primary{background:var(--dsw-alias-state-business-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-business-primary) 80%,transparent);color:var(--dsw-alias-bg-layer-1);font-weight:640;box-shadow:0 2px 10px color-mix(in srgb,var(--dsw-alias-state-business-primary) 30%,transparent),inset 0 1px 0 rgb(255 255 255 / 22%)}
.vg_btn.ghost{background:transparent;box-shadow:none}
.vg_spin{width:11px;height:11px;border-radius:50%;border:1.6px solid color-mix(in srgb,currentColor 30%,transparent);border-top-color:currentColor;animation:vg-spin .7s linear infinite;flex:none}
@keyframes vg-spin{to{transform:rotate(360deg)}}

.vg_notice{display:flex;gap:9px;padding:9px 11px;border-radius:10px;border:1px solid var(--dsw-alias-border-l2);background:color-mix(in srgb,var(--dsw-alias-bg-layer-1) 70%,transparent);font-size:11.5px;line-height:1.55;align-items:flex-start}
.vg_ntitle{font-weight:640;flex:none}
.vg_nbody{color:var(--dsw-alias-label-secondary);word-break:break-word;min-width:0}
.vg_notice.ok{border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary) 42%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 8%,transparent)}
.vg_notice.ok .vg_ntitle{color:var(--dsw-alias-state-success-primary)}
.vg_notice.warn{border-color:color-mix(in srgb,var(--dsw-alias-state-warning-primary,#f0a441) 42%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-warning-primary,#f0a441) 8%,transparent)}
.vg_notice.warn .vg_ntitle{color:var(--dsw-alias-state-warning-primary,#f0a441)}
.vg_notice.err{border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 42%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 8%,transparent)}
.vg_notice.err .vg_ntitle{color:var(--dsw-alias-state-error-primary)}

.vg_kv{display:grid;grid-template-columns:auto 1fr;gap:5px 14px;font-size:11.5px;align-items:baseline;margin:0}
.vg_kv dt{color:var(--dsw-alias-label-tertiary);white-space:nowrap}
.vg_kv dd{margin:0;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;word-break:break-all}

.vg_mlist{display:flex;flex-direction:column;gap:2px;max-height:290px;overflow-y:auto;padding:2px;border-radius:10px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1)}
.vg_mlist::-webkit-scrollbar{width:9px}
.vg_mlist::-webkit-scrollbar-thumb{background:color-mix(in srgb,var(--dsw-alias-label-tertiary) 32%,transparent);border-radius:99px;border:2.5px solid transparent;background-clip:padding-box}
.vg_mitem{display:flex;align-items:center;gap:8px;padding:5px 8px;border-radius:7px;border:0;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:11.5px;text-align:left;cursor:pointer;transition:background .14s ease,color .14s ease}
.vg_mitem:hover{background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 9%,transparent);color:var(--dsw-alias-label-primary)}
.vg_mitem[aria-pressed="true"]{background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 15%,transparent);color:var(--dsw-alias-label-primary);font-weight:600}
.vg_mname{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.vg_vtag{margin-left:auto;font-size:9.5px;font-weight:700;letter-spacing:.3px;padding:1px 6px;border-radius:999px;color:var(--dsw-alias-state-success-primary);border:1px solid color-mix(in srgb,var(--dsw-alias-state-success-primary) 42%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 9%,transparent);flex:none}
.vg_empty{padding:14px;text-align:center;font-size:11.5px;color:var(--dsw-alias-label-tertiary)}
.vg_loading{display:flex;align-items:center;gap:8px;padding:16px;font-size:12px;color:var(--dsw-alias-label-tertiary)}

.vg_evidence{display:flex;flex-direction:column;gap:9px;padding:12px;border-radius:12px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1)}
.vg_esummary{font-size:12.5px;font-weight:600;line-height:1.5}
.vg_meta{display:flex;gap:8px;flex-wrap:wrap;font-size:10.5px;color:var(--dsw-alias-label-tertiary)}
.vg_meta span{padding:1px 7px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1)}
.vg_ocr{margin:0;padding:9px 10px;border-radius:9px;background:color-mix(in srgb,var(--dsw-alias-bg-layer-3) 70%,transparent);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;line-height:1.6;white-space:pre-wrap;word-break:break-word;max-height:260px;overflow:auto}
.vg_regions{display:flex;flex-direction:column;gap:3px;font-size:11px}
.vg_region{display:grid;grid-template-columns:auto auto 1fr;gap:7px;align-items:baseline}
.vg_region i{font-style:normal;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}
.vg_region b{font-weight:600;color:var(--dsw-alias-label-secondary);font-size:10px;text-transform:uppercase;letter-spacing:.3px}
.vg_region span{color:var(--dsw-alias-label-secondary);min-width:0;word-break:break-word}
.vg_ulist{margin:0;padding-left:16px;font-size:11px;color:var(--dsw-alias-label-secondary)}

@media (max-width:620px){.vg_presets{grid-template-columns:1fr}.vg_hrow{grid-template-columns:1fr auto}}
@media (prefers-reduced-motion:reduce){.vg_btn,.vg_preset,.vg_dot,.vg_spin{animation:none;transition:border-color .12s ease,background .12s ease,color .12s ease,opacity .12s ease}.vg_btn:hover:not(:disabled),.vg_preset:hover{transform:none}}
`

    // ── paste channel ─────────────────────────────────────────────────────────
    //
    // 文本模型收不到图片：原生粘贴会在图片准入那一步被拒。所以在捕获阶段
    // 拦下带图的 paste，把字节交给宿主落盘，再把路径文本插回输入框。模型
    // 看到的是一个文件路径，正好是读图工具要的参数。
    //
    // 是否该接管由宿主判定（当前模型是否明确支持图片）；浏览器只缓存 15 秒
    // 的结论，避免每次粘贴都多一个往返。没有结论时按「接管」处理——这个
    // 插件服务的本来就是文本模型，猜错方向会让 ⌘V 直接报错。

    const pasteState = { label: '', at: 0, enabled: true, takeover: true, pending: null }

    function composerLabel() {
      const buttons = document.querySelectorAll('button[aria-label]')
      for (const button of buttons) {
        const label = button.getAttribute('aria-label') || ''
        if (/选择模型|select model|current model/i.test(label)) return label
      }
      return ''
    }

    function refreshVerdict() {
      const label = composerLabel()
      if (pasteState.pending !== null) return pasteState.pending
      if (label === pasteState.label && Date.now() - pasteState.at < 15_000) return Promise.resolve()
      pasteState.pending = (async () => {
        try {
          const response = await fetch(`${API}/paste?model=${encodeURIComponent(label)}`, { headers: { accept: 'application/json' } })
          if (!response.ok) throw new Error(`HTTP ${response.status}`)
          const payload = await response.json()
          pasteState.label = label
          pasteState.at = Date.now()
          pasteState.enabled = payload?.enabled !== false
          pasteState.takeover = payload?.takeover === true
        } catch (error) {
          // 拿不到结论（路由没注册、宿主没装好）时仍然接管：上传会失败，但
          // 失败会插一条看得见的提示，比退回原生、让图片准入悄悄拒掉要好。
          console.error(`[vision] 无法确认模型能力：${error?.message ?? error}`)
          pasteState.enabled = true
          pasteState.takeover = true
        } finally {
          pasteState.pending = null
        }
      })()
      return pasteState.pending
    }

    function imageFilesOf(event) {
      // 这两个列表不是 iterable（没有 Symbol.iterator），只能按索引取。
      const data = event.clipboardData
      const files = []
      const items = data?.items
      if (items) {
        for (let i = 0; i < items.length; i += 1) {
          const item = items[i]
          if (item === null || item === undefined || item.kind !== 'file') continue
          const file = item.getAsFile()
          if (file !== null && /^image\//.test(file.type)) files.push(file)
        }
      }
      const list = data?.files
      if (files.length === 0 && list) {
        for (let i = 0; i < list.length; i += 1) {
          const file = list[i]
          if (file !== null && file !== undefined && /^image\//.test(file.type)) files.push(file)
        }
      }
      return files
    }

    function isWritable(element) {
      if (element === null || element === undefined) return false
      if (element.tagName === 'TEXTAREA' || element.tagName === 'INPUT') return true
      return element.isContentEditable === true || element.getAttribute?.('contenteditable') === 'true'
    }

    function resolveTarget(event) {
      const fromEvent = event.target
      if (fromEvent !== null && fromEvent !== undefined && typeof fromEvent.closest === 'function') {
        const found = fromEvent.closest('textarea, input, [data-composer-input][contenteditable="true"]')
        if (found !== null) return found
      }
      const active = document.activeElement
      return isWritable(active) ? active : null
    }

    function insertText(target, text) {
      if (target === null) return false
      try { target.focus() } catch { /* 焦点拿不到也照样试插入 */ }
      try {
        if (document.execCommand('insertText', false, text)) return true
      } catch { /* 落到下面的 setter */ }
      // 输入框有 value setter；Lexical 那类 contenteditable 没有，只能靠
      // execCommand 那条路，插入失败就如实返回。
      if (target.tagName !== 'TEXTAREA' && target.tagName !== 'INPUT') return false
      try {
        const proto = target.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype
        const setter = Object.getOwnPropertyDescriptor(proto, 'value').set
        setter.call(target, target.value + text)
        target.dispatchEvent(new Event('input', { bubbles: true }))
        return true
      } catch {
        return false
      }
    }

    async function uploadAndInsert(files, target) {
      for (const file of files) {
        try {
          const response = await fetch(`${API}/paste`, {
            method: 'POST',
            headers: { 'content-type': 'application/octet-stream' },
            body: await file.arrayBuffer(),
          })
          const payload = await response.json().catch(() => ({}))
          if (!response.ok) throw new Error(payload?.error ?? `HTTP ${response.status}`)
          if (typeof payload?.path !== 'string' || payload.path === '') throw new Error('宿主没有返回路径')
          if (!insertText(target, `${payload.path} `)) throw new Error('无法把路径插入输入框')
        } catch (error) {
          const message = String(error?.message ?? error)
          console.error(`[vision] 粘贴失败：${message}`)
          insertText(target, `[视觉插件：图片粘贴失败，${message}] `)
        }
      }
    }

    function takePaste(event) {
      if (!pasteState.enabled || !pasteState.takeover) return
      try {
        const files = imageFilesOf(event)
        if (files.length === 0) return
        const target = resolveTarget(event)
        if (target === null) return
        // 先占住这次粘贴：原生流程一开始就会创建附件并触发准入失败。
        event.preventDefault()
        event.stopPropagation()
        void uploadAndInsert(files, target)
      } catch (error) {
        console.error(`[vision] 粘贴处理失败：${error?.message ?? error}`)
      }
    }

    // ── atoms ─────────────────────────────────────────────────────────────────
    function Pill(props) {
      return h('span', { className: 'vg_pill' },
        props.tone ? h('span', { className: `vg_dot ${props.tone}` }) : null,
        props.children)
    }

    function Spinner() {
      return h('span', { className: 'vg_spin' })
    }

    function Notice(props) {
      const children = [
        h('span', { key: 'title', className: 'vg_ntitle' }, props.title),
      ]
      if (props.body) children.push(h('span', { key: 'body', className: 'vg_nbody' }, props.body))
      if (props.onClose) {
        children.push(h('button', {
          key: 'close',
          className: 'vg_iconbtn',
          type: 'button',
          style: { width: '20px', height: '20px', marginLeft: 'auto', flex: 'none' },
          onClick: props.onClose,
        }, '×'))
      }
      return h('div', { className: `vg_notice ${props.tone ?? ''}` }, children)
    }

    function Field(props) {
      const children = [
        h('span', { key: 'label', className: 'vg_label' },
          props.label,
          props.required ? h('span', { key: 'req', className: 'vg_req' }, '*') : null,
          props.mark ? h('span', { key: 'mark', className: 'vg_mark' }, props.mark) : null),
        props.children,
      ]
      if (props.hint) children.push(h('span', { key: 'hint', className: 'vg_hint' }, props.hint))
      return h('label', { className: `vg_field${props.wide ? ' wide' : ''}` }, children)
    }

    function TextInput(props) {
      return h('input', {
        className: `vg_input${props.mono ? ' mono' : ''}`,
        value: props.value ?? '',
        placeholder: props.placeholder ?? '',
        type: props.type ?? 'text',
        spellCheck: false,
        autoComplete: 'off',
        onChange: event => props.onChange(event.target.value),
      })
    }

    function Section(props) {
      return h('section', { className: 'vg_sec' },
        h('div', { className: 'vg_sechead' },
          h('span', { className: 'vg_sectitle' }, props.title),
          props.hint ? h('span', { className: 'vg_sechint' }, props.hint) : null),
        props.children)
    }

    // ── sub-pages ─────────────────────────────────────────────────────────────

    function PresetPicker(props) {
      const { draft, presets, patch, onDelete, onRestore, onSave, hiddenCount, busy } = props
      return h(Fragment, null,
        h('div', { className: 'vg_actions' },
          h('div', { className: 'vg_seg', role: 'group', 'aria-label': '上游协议' },
            ['openai', 'anthropic'].map(protocol => h('button', {
              key: protocol,
              type: 'button',
              'aria-pressed': draft.protocol === protocol ? 'true' : 'false',
              onClick: () => patch({ protocol }),
            }, protocol === 'openai' ? 'OpenAI 协议' : 'Anthropic 协议'))),
          h('span', { className: 'vg_hint' },
            draft.protocol === 'openai'
              ? 'POST /chat/completions · Authorization: Bearer <key>'
              : 'POST /messages · x-api-key + anthropic-version')),
        h('div', { className: 'vg_presets' },
          presets.length === 0
            ? h('div', { className: 'vg_empty' }, '预设都被移除了。可以恢复，或者把当前配置存成一个。')
            : presets.map(preset => h('div', {
              key: preset.id,
              className: 'vg_preset',
              'aria-pressed': draft.baseUrl !== '' && draft.baseUrl === preset.baseUrl ? 'true' : 'false',
            },
            h('button', {
              type: 'button',
              className: 'vg_presetmain',
              onClick: () => patch({
                protocol: preset.protocol,
                baseUrl: preset.baseUrl,
                model: preset.model,
                extraHeaders: { ...(preset.extraHeaders ?? {}) },
              }),
            },
            h('span', { className: 'vg_presetname' },
              preset.label,
              h('span', { className: `vg_chip ${preset.protocol}` }, preset.protocol === 'openai' ? 'OpenAI' : 'Anthropic')),
            h('span', { className: 'vg_presetid' }, preset.model || '—'),
            h('span', { className: 'vg_preseturl' }, preset.baseUrl || '（自行填写）')),
            h('button', {
              type: 'button',
              className: 'vg_presetdel',
              title: preset.builtin ? '从列表里移除（内置预设，可随时恢复）' : '删除这个预设',
              'aria-label': `移除预设 ${preset.label}`,
              onClick: () => onDelete(preset),
            }, '×')))),
        h('div', { className: 'vg_actions' },
          hiddenCount > 0
            ? h('button', { className: 'vg_btn ghost', type: 'button', disabled: busy !== '', onClick: onRestore },
              busy === 'restore' ? h(Spinner) : null, `恢复已移除的预设（${hiddenCount}）`)
            : null,
          h('button', {
            className: 'vg_btn ghost',
            type: 'button',
            disabled: busy !== '' || draft.baseUrl.trim() === '',
            onClick: onSave,
          }, busy === 'save' ? h(Spinner) : null, '把当前配置存为预设'),
          h('span', { className: 'vg_hint' }, '悬停卡片右上角可以移除')))
    }

    function ConnectionForm(props) {
      const { draft, base, patch, busy, clearKey, onClear, fetchModels, models, setModels, modelQuery, setModelQuery, filtered } = props
      const isAnthropic = draft.protocol === 'anthropic'

      const keyField = h(Field, {
        key: 'key',
        wide: true,
        label: 'API Key',
        required: !base.hasKey,
        mark: base.hasKey ? '已配置（留空不改）' : '',
        hint: base.hasKey
          ? `当前：${base.keyPreview}。留空表示沿用已存的密钥。`
          : '只写入本机 ~/.dsh/vision/config.json（权限 600），不回传浏览器。',
      }, h(TextInput, {
        value: draft.apiKey,
        type: 'password',
        mono: true,
        placeholder: base.hasKey ? '••••••••（留空则沿用）' : 'sk-…',
        onChange: value => patch({ apiKey: value }),
      }))

      const modelField = h(Field, {
        key: 'model',
        wide: true,
        label: '模型名',
        required: true,
        mark: models?.list ? `${models.list.length} 个可选` : '',
        hint: '必须是能看图的模型（名字通常含 vl / vision / omni）。可点「列出模型」从上游拉取。',
      }, h(TextInput, {
        value: draft.model,
        mono: true,
        placeholder: isAnthropic ? 'claude-sonnet-4-5' : 'gpt-4.1-mini',
        onChange: value => patch({ model: value }),
      }))

      const urlField = h(Field, {
        key: 'url',
        wide: true,
        label: '上游地址',
        required: true,
        hint: isAnthropic
          ? '读图时会请求 <baseUrl>/messages（结尾带不带 /v1 都行）'
          : '读图时会请求 <baseUrl>/chat/completions（结尾带不带 /v1 都行）',
      }, h(TextInput, {
        value: draft.baseUrl,
        mono: true,
        placeholder: isAnthropic ? 'https://api.anthropic.com/v1' : 'https://api.openai.com/v1',
        onChange: value => patch({ baseUrl: value }),
      }))

      const nothingToClear = draft.baseUrl.trim() === '' && draft.model.trim() === '' && base.hasKey !== true
      const buttons = h('div', { key: 'buttons', className: 'vg_actions' },
        base.hasKey ? h('button', { className: 'vg_btn ghost', type: 'button', disabled: busy !== '', onClick: clearKey }, '清除已存密钥') : null,
        h('button', {
          className: 'vg_btn ghost',
          type: 'button',
          disabled: busy !== '' || nothingToClear,
          onClick: onClear,
        }, busy === 'clear' ? h(Spinner) : null, '清空上游与密钥'),
        h('button', {
          className: 'vg_btn',
          type: 'button',
          disabled: busy !== '' || draft.baseUrl.trim() === '',
          onClick: fetchModels,
        }, busy === 'models' ? h(Spinner) : null, '列出模型'))

      let modelBrowser = null
      if (models !== null) {
        const parts = []
        if (models.loading) parts.push(h('div', { key: 'l', className: 'vg_loading' }, h(Spinner), '正在向上游请求模型列表…'))
        if (models.error) parts.push(h(Notice, { key: 'e', tone: 'err', title: '拉取模型失败', body: models.error }))
        if (models.list) {
          parts.push(h('input', {
            key: 'q',
            className: 'vg_input',
            value: modelQuery,
            placeholder: '搜索模型…',
            spellCheck: false,
            onChange: event => setModelQuery(event.target.value),
          }))
          parts.push(h('div', { key: 'list', className: 'vg_mlist' },
            filtered.length === 0 ? h('div', { className: 'vg_empty' }, '没有匹配的模型') : null,
            filtered.map(item => h('button', {
              key: item.id,
              type: 'button',
              className: 'vg_mitem',
              'aria-pressed': draft.model.trim() === item.id ? 'true' : 'false',
              onClick: () => { patch({ model: item.id }); setModels(null); setModelQuery('') },
            },
            h('span', { className: 'vg_mname' }, item.id),
            /vl|vision|omni|multimodal|gpt-4|gemini|claude|glm/i.test(item.id)
              ? h('span', { className: 'vg_vtag' }, '视觉')
              : null))))
        }
        modelBrowser = h('div', { className: 'vg_field wide' }, parts)
      }

      return h('div', { className: 'vg_panel' },
        h('div', { className: 'vg_form' }, urlField, modelField, keyField),
        buttons,
        modelBrowser)
    }

    function HeaderEditor(props) {
      const { draft, patch } = props
      const entries = Object.entries(draft.extraHeaders ?? {})

      const rows = entries.map(([name, value], index) => h('div', { className: 'vg_hrow', key: `${index}:${name}` },
        h('input', {
          className: 'vg_input mono',
          value: name,
          placeholder: 'x-opencode-session',
          spellCheck: false,
          onChange: event => {
            const next = {}
            entries.forEach(([k, v], i) => { next[i === index ? event.target.value : k] = v })
            patch({ extraHeaders: next })
          },
        }),
        h('input', {
          className: 'vg_input mono',
          value,
          placeholder: '$uuid',
          spellCheck: false,
          onChange: event => patch({ extraHeaders: { ...(draft.extraHeaders ?? {}), [name]: event.target.value } }),
        }),
        h('button', {
          className: 'vg_btn ghost',
          type: 'button',
          title: `删除请求头 ${name}`,
          style: { padding: '4px 10px', fontSize: '11.5px' },
          onClick: () => {
            const next = { ...(draft.extraHeaders ?? {}) }
            delete next[name]
            patch({ extraHeaders: next })
          },
        }, '删除')))

      rows.push(h('div', { key: 'add' },
        h('button', {
          className: 'vg_btn ghost',
          type: 'button',
          onClick: () => {
            let name = 'x-custom-header'
            let i = 2
            while ((draft.extraHeaders ?? {})[name] !== undefined) { name = `x-custom-header-${i}`; i += 1 }
            patch({ extraHeaders: { ...(draft.extraHeaders ?? {}), [name]: '' } })
          },
        }, '+ 添加请求头')))

      return h(Fragment, null,
        h('div', { className: 'vg_ptitle' },
          '额外请求头',
          h('span', { className: 'vg_phint' }, '值写 $uuid 表示每次请求换一个新 uuid')),
        h('div', { className: 'vg_hrows' }, rows))
    }

    function GatewayForm(props) {
      const { draft, patch } = props
      return h(Fragment, null,
        h('div', { className: 'vg_ptitle' },
          '本机兼容端点',
          h('span', { className: 'vg_phint' }, '可选 · 给别的程序接进来用')),
        h('div', { className: 'vg_form' },
          h('label', { className: 'vg_field' },
            h('span', { className: 'vg_label' }, '启用'),
            h('div', { className: 'vg_seg' },
              h('button', { type: 'button', 'aria-pressed': draft.gatewayEnabled ? 'true' : 'false', onClick: () => patch({ gatewayEnabled: true }) }, '开启'),
              h('button', { type: 'button', 'aria-pressed': draft.gatewayEnabled ? 'false' : 'true', onClick: () => patch({ gatewayEnabled: false }) }, '关闭')),
            h('span', { className: 'vg_hint' }, '读图工具不走它——它只是把同一份配置暴露成一个 OpenAI / Anthropic 兼容的本地端口。')),
          h(Field, {
            label: '监听端口',
            hint: '留空 = 系统分配。保存后会固化。',
          }, h(TextInput, {
            value: draft.gatewayPort,
            mono: true,
            placeholder: '自动',
            onChange: value => patch({ gatewayPort: value.replace(/[^0-9]/g, '') }),
          })),
          h(Field, {
            label: '会话头',
            hint: '补 x-opencode-session: <uuid>。OpenCode 的 go 车道强制要求，别处一般不需要。',
          }, h('div', { className: 'vg_seg' },
            h('button', { type: 'button', 'aria-pressed': draft.sessionHeader ? 'true' : 'false', onClick: () => patch({ sessionHeader: true }) }, '注入'),
            h('button', { type: 'button', 'aria-pressed': draft.sessionHeader ? 'false' : 'true', onClick: () => patch({ sessionHeader: false }) }, '不注入')))))
    }

    function PasteForm(props) {
      const { draft, patch } = props
      return h(Fragment, null,
        h('div', { className: 'vg_ptitle' },
          '粘贴通道',
          h('span', { className: 'vg_phint' }, '⌘V 一张图 → 本机路径')),
        h('div', { className: 'vg_form' },
          h('label', { className: 'vg_field' },
            h('span', { className: 'vg_label' }, '接管图片粘贴'),
            h('div', { className: 'vg_seg' },
              h('button', { type: 'button', 'aria-pressed': draft.pasteToPath ? 'true' : 'false', onClick: () => patch({ pasteToPath: true }) }, '接管'),
              h('button', { type: 'button', 'aria-pressed': draft.pasteToPath ? 'false' : 'true', onClick: () => patch({ pasteToPath: false }) }, '原生')),
            h('span', { className: 'vg_hint' }, '接管：图片存进 ~/.dsh/vision/pastes/，输入框里出现路径，模型再用读图工具读它。原生：交给宿主的附件流程——只有支持图片输入的模型才走得通。')),
          h(Field, {
            label: '保留张数',
            hint: '滚动覆盖：只留最近这么多张，更早的自动删除。0 = 不限。',
          }, h(TextInput, {
            value: draft.pasteKeep,
            mono: true,
            placeholder: '10',
            onChange: value => patch({ pasteKeep: value.replace(/[^0-9]/g, '') }),
          }))))
    }

    /** 插件自己的状态：工具有没有注册上、上一次读图是什么。 */
    function ToolCard(props) {
      const { base } = props
      const last = base.lastRead
      return h('div', { className: 'vg_panel' },
        h('dl', { className: 'vg_kv' },
          h('dt', null, '工具名'), h('dd', { className: 'vg_mono' }, base.toolName || '（未设置）'),
          h('dt', null, '注册状态'), h('dd', null, base.toolRegistered ? '已注册，模型每一轮都能看到' : '未注册（改了工具名需要重启宿主）'),
          h('dt', null, '配置文件'), h('dd', { className: 'vg_mono' }, base.configPath ?? '')),
        last === null || last === undefined
          ? h(Notice, { tone: 'warn', title: '还没有读过图', body: '在下面「读图自检」里试一张，或在对话里直接引用图片路径。' })
          : h('dl', { className: 'vg_kv' },
            h('dt', null, '上一次'), h('dd', null, new Date(last.at).toLocaleString()),
            h('dt', null, '来源'), h('dd', { className: 'vg_mono' }, last.source),
            h('dt', null, '结果'), h('dd', null, `${last.ms} ms · OCR ${last.ocrChars} 字 · ${last.model}`),
            h('dt', null, '摘要'), h('dd', null, last.summary || '（空）')))
    }

    /** 读图自检：和工具同一条链路，当场看证据。 */
    function ReadTester(props) {
      const { base } = props
      const [path, setPath] = useState('')
      const [focus, setFocus] = useState('')
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState('')
      const [result, setResult] = useState(null)

      const run = useCallback(async () => {
        setBusy(true)
        setError('')
        setResult(null)
        try {
          const payload = await post('/read', { path, prompt: focus }, 240_000)
          setResult(payload)
        } catch (err) {
          setError(String(err?.message ?? err))
        } finally {
          setBusy(false)
        }
      }, [path, focus])

      let view = null
      if (result !== null) {
        const evidence = result.evidence ?? {}
        const meta = evidence.meta ?? {}
        view = h('div', { className: 'vg_evidence' },
          h('div', { className: 'vg_esummary' }, evidence.summary || '（没有摘要）'),
          h('div', { className: 'vg_meta' },
            h('span', null, `${meta.ms ?? 0} ms`),
            h('span', null, meta.model ?? ''),
            h('span', null, `${Math.round((meta.bytes ?? 0) / 1024)} KB`),
            h('span', null, meta.mime ?? '')),
          (evidence.ocr?.full_text ?? '') === ''
            ? h('div', { className: 'vg_hint' }, '这张图里没有读出文字。')
            : h('pre', { className: 'vg_ocr' }, evidence.ocr.full_text),
          (evidence.layout?.regions ?? []).length === 0 ? null : h('div', { className: 'vg_regions' },
            evidence.layout.regions.map(region => h('div', { className: 'vg_region', key: `${region.reading_order}:${region.type}` },
              h('i', null, region.reading_order),
              h('b', null, region.type),
              h('span', null, region.text || '（无文字）')))),
          (evidence.uncertainty ?? []).length === 0 ? null : h('ul', { className: 'vg_ulist' },
            evidence.uncertainty.map((item, index) => h('li', { key: index }, item))))
      }

      return h('div', { className: 'vg_panel' },
        h('div', { className: 'vg_form' },
          h(Field, {
            wide: true,
            label: '图片路径或 URL',
            hint: '本地绝对路径、~/…、相对工作区路径，或 http(s) 链接。支持 PNG / JPEG / GIF / WebP，单张 ≤ 8MB。',
          }, h(TextInput, {
            value: path,
            mono: true,
            placeholder: '~/Desktop/shot.png',
            onChange: setPath,
          })),
          h(Field, {
            wide: true,
            label: '关注点（可选）',
            hint: '只写这一次想额外注意的东西，比如「重点看表格里的金额」。',
          }, h(TextInput, {
            value: focus,
            placeholder: '',
            onChange: setFocus,
          }))),
        h('div', { className: 'vg_actions' },
          h('button', {
            className: 'vg_btn primary',
            type: 'button',
            disabled: busy || path.trim() === '',
            onClick: run,
          }, busy ? h(Spinner) : null, busy ? '正在读…' : '读这张图'),
          busy ? h('span', { className: 'vg_hint' }, '首次读一张图通常 5–20 秒，取决于上游。') : null),
        error === '' ? null : h(Notice, { tone: 'err', title: '读图失败', body: error, onClose: () => setError('') }),
        view)
    }

    // ── page ──────────────────────────────────────────────────────────────────
    function SettingsPage() {
      const [status, setStatus] = useState('loading') // loading | ready | error
      const [error, setError] = useState('')
      const [base, setBase] = useState(null) // 磁盘上的现状
      const [draft, setDraft] = useState(null) // 正在编辑的值
      const [busy, setBusy] = useState('')
      const [notice, setNotice] = useState(null)
      const [testResult, setTestResult] = useState(null)
      const [models, setModels] = useState(null)
      const [modelQuery, setModelQuery] = useState('')

      const adopt = useCallback(summary => {
        setStatus('ready')
        setError('')
        setBase(summary)
        setDraft({
          protocol: summary.protocol === 'anthropic' ? 'anthropic' : 'openai',
          baseUrl: summary.baseUrl ?? '',
          model: summary.model ?? '',
          apiKey: '',
          extraHeaders: { ...(summary.extraHeaders ?? {}) },
          sessionHeader: summary.sessionHeader !== false,
          pasteToPath: summary.pasteToPath !== false,
          pasteKeep: String(summary.pasteKeep ?? 10),
          gatewayEnabled: summary.gateway?.enabled === true,
          gatewayPort: String(summary.gateway?.requestedPort || ''),
        })
      }, [])

      const load = useCallback(() => {
        setStatus('loading')
        get('/summary').then(adopt).catch(err => {
          setStatus('error')
          setError(String(err?.message ?? err))
        })
      }, [adopt])

      useEffect(() => { load() }, [load])

      const patch = useCallback(fields => {
        setDraft(current => (current === null ? current : { ...current, ...fields }))
        setNotice(null)
      }, [])

      const dirty = useMemo(() => {
        if (base === null || draft === null) return false
        if (draft.protocol !== (base.protocol === 'anthropic' ? 'anthropic' : 'openai')) return true
        if (draft.baseUrl.trim() !== (base.baseUrl ?? '')) return true
        if (draft.model.trim() !== (base.model ?? '')) return true
        if (draft.apiKey.trim() !== '') return true
        if (draft.sessionHeader !== (base.sessionHeader !== false)) return true
        if (draft.pasteToPath !== (base.pasteToPath !== false)) return true
        if (String(draft.pasteKeep).trim() !== String(base.pasteKeep ?? 10)) return true
        if (draft.gatewayEnabled !== (base.gateway?.enabled === true)) return true
        if (String(draft.gatewayPort).trim() !== String(base.gateway?.requestedPort || '')) return true
        const mine = Object.entries(draft.extraHeaders ?? {}).filter(([k, v]) => k.trim() !== '' && String(v).trim() !== '')
        const theirs = Object.entries(base.extraHeaders ?? {}).filter(([k, v]) => k.trim() !== '' && String(v).trim() !== '')
        if (mine.length !== theirs.length) return true
        return mine.some(([k, v]) => (base.extraHeaders?.[k] ?? '') !== v)
      }, [base, draft])

      const run = useCallback(async (id, fn) => {
        setBusy(id)
        setNotice(null)
        try { await fn() } catch (err) {
          setNotice({ tone: 'err', title: '失败', body: String(err?.message ?? err) })
        } finally { setBusy('') }
      }, [])

      const payload = useCallback(() => {
        const port = Number(String(draft.gatewayPort).trim())
        return {
          protocol: draft.protocol,
          baseUrl: draft.baseUrl,
          model: draft.model,
          apiKey: draft.apiKey,
          extraHeaders: draft.extraHeaders,
          sessionHeader: draft.sessionHeader,
          pasteToPath: draft.pasteToPath,
          pasteKeep: Number(String(draft.pasteKeep).trim() === '' ? 10 : draft.pasteKeep),
          gateway: {
            enabled: draft.gatewayEnabled,
            ...(Number.isInteger(port) && port > 0 ? { port } : {}),
          },
        }
      }, [draft])

      const save = useCallback(() => run('save', async () => {
        const summary = await post('/save', payload())
        adopt(summary)
        setNotice({ tone: 'ok', title: '已保存', body: summary.configPath })
      }), [run, payload, adopt])

      const clearKey = useCallback(() => run('clearKey', async () => {
        const summary = await post('/save', { clearKey: true })
        adopt(summary)
        setNotice({ tone: 'ok', title: '密钥已清除', body: '保存前请重新填写。' })
      }), [run, adopt])

      const reset = useCallback(() => {
        if (!window.confirm('清空视觉配置并回到默认值？上游、模型、密钥、额外请求头都会被删掉。')) return
        run('reset', async () => {
          const summary = await post('/reset', {})
          adopt(summary)
          setNotice({ tone: 'ok', title: '已重置', body: '配置回到默认值，粘贴张数恢复 10。' })
        })
      }, [run, adopt])

      const presetAction = useCallback(async (key, body, notice) => {
        setBusy(key)
        setNotice(null)
        try {
          const summary = await post('/presets', body)
          adopt(summary)
          setNotice(notice)
        } catch (err) {
          setNotice({ tone: 'err', title: '操作失败', body: String(err?.message ?? err) })
        } finally {
          setBusy('')
        }
      }, [adopt])

      const deletePreset = useCallback(preset => {
        presetAction(
          'preset',
          { action: preset.builtin ? 'hide' : 'remove', id: preset.id },
          {
            tone: 'ok',
            title: preset.builtin ? '已从列表移除' : '已删除预设',
            body: preset.builtin ? '内置预设只是隐藏，上面「恢复已移除的预设」能找回来。' : preset.label,
          },
        )
      }, [presetAction])

      const restorePresets = useCallback(() => {
        presetAction('restore', { action: 'restore' }, { tone: 'ok', title: '预设已恢复', body: '全部内置预设回到列表。' })
      }, [presetAction])

      const savePreset = useCallback(() => {
        const label = window.prompt('给这个预设起个名字', draft.model || '我的预设')
        if (label === null || label.trim() === '') return
        presetAction(
          'save',
          {
            action: 'save',
            preset: {
              label,
              protocol: draft.protocol,
              baseUrl: draft.baseUrl,
              model: draft.model,
              extraHeaders: draft.extraHeaders,
            },
          },
          { tone: 'ok', title: '预设已保存', body: `「${label.trim()}」现在在列表里，点一下就能填回来。` },
        )
      }, [presetAction, draft])

      const clearConnection = useCallback(() => {
        if (!window.confirm('清空上游地址、模型名和密钥？预设和请求头不受影响。')) return
        run('clear', async () => {
          const summary = await post('/save', { baseUrl: '', model: '', clearKey: true })
          adopt(summary)
          setNotice({ tone: 'ok', title: '已清空连接参数', body: '上游、模型、密钥都已删除。' })
        })
      }, [run, adopt])

      const test = useCallback(() => run('test', async () => {
        setTestResult(null)
        if (dirty) {
          setNotice({ tone: 'warn', title: '有未保存的改动', body: '测试读的是磁盘配置，先「保存」才作数。' })
          return
        }
        const result = await post('/test', {}, 180_000)
        setTestResult(result)
        setNotice(result.ok
          ? { tone: 'ok', title: '上游连通', body: `${result.elapsedMs} ms · 回答：${result.answer || '（空）'}` }
          : { tone: 'err', title: `上游返回 HTTP ${result.status}`, body: result.error })
      }), [run, dirty])

      const fetchModels = useCallback(() => run('models', async () => {
        setModels({ loading: true })
        try {
          // 后端把列表包在 `{ models: [...] }` 里返回，这里必须按字段名取。
          // 曾经后端直接吐裸数组，这一行 `result?.models` 恒为 undefined，
          // 于是「拉取模型列表」永远显示 0 个且不报错。
          const result = await post('/models', {}, 60_000)
          setModels({ list: Array.isArray(result?.models) ? result.models : [] })
        } catch (err) {
          setModels({ error: String(err?.message ?? err) })
        }
      }), [run])

      const filtered = useMemo(() => {
        const list = models?.list ?? []
        const q = modelQuery.trim().toLowerCase()
        return q === '' ? list : list.filter(item => String(item.id).toLowerCase().includes(q))
      }, [models, modelQuery])

      if (status === 'loading') {
        return h('div', { className: 'vg_root' },
          h('div', { className: 'vg_panel' }, h('div', { className: 'vg_loading' }, h(Spinner), '正在读取视觉模型配置…')))
      }
      if (status === 'error') {
        return h('div', { className: 'vg_root' },
          h('div', { className: 'vg_panel' },
            h('div', { className: 'vg_ptitle' }, '视觉模型'),
            h(Notice, { tone: 'err', title: '无法连接插件后端', body: error }),
            h('div', { className: 'vg_actions' },
              h('button', { className: 'vg_btn', type: 'button', onClick: load }, '重试'))))
      }

      const gatewayPort = base.gateway?.port ?? 0
      const gatewayOn = base.gateway?.enabled === true && gatewayPort > 0
      const presets = Array.isArray(base.presets) ? base.presets : []

      const heroPills = [
        h(Pill, { key: 'tool', tone: base.toolRegistered ? 'ok' : 'warn' },
          base.toolRegistered ? `工具 ${base.toolName}` : '工具未注册'),
        h(Pill, { key: 'key', tone: base.hasKey ? 'ok' : 'warn' }, base.hasKey ? '密钥已配置' : '缺少密钥'),
      ]
      heroPills.push(h(Pill, { key: 'paste', tone: base.pasteToPath === false ? '' : 'ok' },
        base.pasteToPath === false ? '粘贴走原生' : '粘贴→路径'))
      if (base.gateway?.enabled === true) {
        heroPills.push(h(Pill, { key: 'gw', tone: gatewayOn ? 'ok' : 'warn' }, gatewayOn ? `兼容端点 :${gatewayPort}` : '端点未运行'))
      }
      if (dirty) heroPills.push(h(Pill, { key: 'dirty', tone: 'warn' }, '有未保存的改动'))

      const hero = h('header', { className: 'vg_hero' },
        h('div', { className: 'vg_head' },
          h('div', { className: 'vg_title' },
            h('h2', null, '视觉模型'),
            h('p', { className: 'vg_sub' }, '给纯文本模型配一双眼睛：插件自己注册读图工具、自己直连上游，不依赖任何外部视觉工具。保存后，在对话里引用图片路径即可。')),
          h('div', { className: 'vg_pills' }, heroPills)))

      const presetSection = h(Section, { title: '协议与上游', hint: '预设是模板：点了只填进下面的表单，不会存成条目' },
        h(PresetPicker, {
          draft,
          presets,
          patch,
          onDelete: deletePreset,
          onRestore: restorePresets,
          onSave: savePreset,
          hiddenCount: base.hiddenPresets ?? 0,
          busy,
        }),
        notice ? h(Notice, { tone: notice.tone, title: notice.title, body: notice.body, onClose: () => setNotice(null) }) : null)

      const formSection = h(Section, {
        title: '连接参数',
        hint: draft.protocol === 'anthropic' ? 'Anthropic Messages 协议' : 'OpenAI Chat Completions 协议',
      }, h(ConnectionForm, {
        draft, base, patch, busy, clearKey, onClear: clearConnection, fetchModels,
        models, setModels, modelQuery, setModelQuery, filtered,
      }))

      const toolSection = h(Section, { title: '读图工具', hint: '插件自己的工具，不需要外部 CLI' },
        h(ToolCard, { base }))

      const testSection = h(Section, { title: '读图自检', hint: '走的是工具同一条链路' },
        h(ReadTester, { base }))

      const advancedSection = h(Section, { title: '高级', hint: '只在需要时动' },
        h('div', { className: 'vg_panel' },
          h(PasteForm, { draft, patch }),
          h(HeaderEditor, { draft, patch }),
          h(GatewayForm, { draft, patch })))

      const actionButtons = [
        h('button', { key: 'save', className: 'vg_btn primary', type: 'button', disabled: busy !== '' || !dirty, onClick: save },
          busy === 'save' ? h(Spinner) : null, dirty ? '保存改动' : '已保存'),
        h('button', { key: 'test', className: 'vg_btn', type: 'button', disabled: busy !== '', onClick: test },
          busy === 'test' ? h(Spinner) : null, '测试连接'),
        h('button', { key: 'reset', className: 'vg_btn ghost', type: 'button', disabled: busy !== '', onClick: reset },
          busy === 'reset' ? h(Spinner) : null, '重置配置'),
      ]
      if (dirty) {
        actionButtons.push(h('button', { key: 'reset', className: 'vg_btn ghost', type: 'button', onClick: () => adopt(base) }, '放弃改动'))
      }
      actionButtons.push(h('span', { key: 'state', className: 'vg_hint' }, dirty ? '改动还没落盘' : '配置已落盘'))

      const resultNotice = testResult === null ? null : h(Notice, {
        tone: testResult.ok ? 'ok' : 'err',
        title: testResult.ok
          ? `连通 · HTTP ${testResult.status} · ${testResult.elapsedMs} ms`
          : `失败 · HTTP ${testResult.status}`,
        body: testResult.ok ? `模型回答：${testResult.answer || '（空）'}` : testResult.error,
        onClose: () => setTestResult(null),
      })

      const actionSection = h(Section, { title: '操作', hint: base.configPath },
        h('div', { className: 'vg_actions' }, actionButtons),
        resultNotice)

      return h('div', { className: 'vg_root' },
        hero, presetSection, formSection, toolSection, testSection, advancedSection, actionSection)
    }

    // ── wiring ────────────────────────────────────────────────────────────────
    function apply(ctx) {
      ctx.effect(() => {
        const onPaste = event => takePaste(event)
        const onFocus = () => { void refreshVerdict() }
        document.addEventListener('paste', onPaste, true)
        document.addEventListener('focusin', onFocus, true)
        void refreshVerdict()
        return () => {
          document.removeEventListener('paste', onPaste, true)
          document.removeEventListener('focusin', onFocus, true)
        }
      }, 'vision: paste channel')

      ctx.effect(() => {
        const style = document.createElement('style')
        style.setAttribute('data-plugin', 'dsh-vision-direct')
        style.textContent = CSS
        document.head.appendChild(style)
        return () => style.remove()
      }, 'vision: styles')

      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'vision',
        order: 36,
        label: () => '视觉模型',
      }, () => h(SettingsPage, null)))
    }

    exports.apply = apply
    exports.inject = inject
    exports.name = 'vision'
    exports.__test = { SettingsPage, HeaderEditor, ToolCard, ReadTester, Pill, Notice }
    return module.exports
  },
})
