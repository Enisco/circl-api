export const SWAGGER_CUSTOM_CSS = `
  @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap');

  /* ══════════════════════════════════════════
     FORCE DARK — always, regardless of system
  ══════════════════════════════════════════ */
  html { color-scheme: dark !important; }

  /* ══════════════════════════════════════════
     BASE
  ══════════════════════════════════════════ */
  html, body { margin: 0; padding: 0; background: #111111 !important; }
  .swagger-ui {
    font-family: 'Inter', 'Segoe UI', system-ui, sans-serif !important;
    background: #111111 !important;
    color: #F5F5F5 !important;
  }
  .swagger-ui * { box-sizing: border-box; }
  .swagger-ui .wrapper,
  .swagger-ui .information-container,
  .swagger-ui .filter,
  .swagger-ui .filter-container,
  .swagger-ui section.models { background: #111111 !important; }

  /* ══════════════════════════════════════════
     TOP BAR — hidden entirely
  ══════════════════════════════════════════ */
  .swagger-ui .topbar { display: none !important; }

  /* ══════════════════════════════════════════
     INFO BLOCK
  ══════════════════════════════════════════ */
  .swagger-ui .info { margin: 28px 0 20px; }
  .swagger-ui .info .title {
    color: #CCFF00 !important;
    font-size: 30px !important;
    font-weight: 700 !important;
    letter-spacing: -0.6px;
    margin: 0;
  }
  .swagger-ui .info .title small.version-stamp {
    background: #CCFF00 !important;
    border-radius: 5px;
    color: #111111 !important;
    font-size: 11px;
    font-weight: 700;
    padding: 3px 10px;
    letter-spacing: 0.04em;
    margin-left: 8px;
    vertical-align: middle;
  }
  .swagger-ui .info p,
  .swagger-ui .info li { color: #CCFF00 !important; font-size: 14px; line-height: 1.7; }
  .swagger-ui .info a { color: #CCFF00 !important; text-decoration: none; }
  .swagger-ui .info a:hover { text-decoration: underline; }
  .swagger-ui .info .base-url { color: rgba(245,245,245,0.4) !important; font-size: 12px; }

  /* ══════════════════════════════════════════
     SCHEME / SERVER
  ══════════════════════════════════════════ */
  .swagger-ui .scheme-container {
    background: #111111 !important;
    border: 1.5px solid #CCFF00 !important;
    border-radius: 10px;
    box-shadow: 0 0 18px rgba(204,255,0,0.1);
    padding: 16px 20px;
    margin: 0 0 24px;
  }
  .swagger-ui .schemes > label,
  .swagger-ui .servers > label,
  .swagger-ui .servers h4,
  .swagger-ui .scheme-container label,
  .swagger-ui .servers label {
    color: #CCFF00 !important;
    font-size: 10px !important;
    font-weight: 700 !important;
    letter-spacing: 0.1em;
    text-transform: uppercase;
  }
  .swagger-ui .scheme-container .schemes select,
  .swagger-ui .servers select {
    background: #2A2A2A !important;
    border: 1px solid #3a3a3a !important;
    border-radius: 7px;
    color: #CCFF00 !important;
    font-size: 13px;
    padding: 7px 12px;
    outline: none;
  }
  .swagger-ui .scheme-container .schemes select:focus,
  .swagger-ui .servers select:focus {
    border-color: #CCFF00 !important;
    box-shadow: 0 0 0 3px rgba(204,255,0,0.18) !important;
  }
  .swagger-ui select option { background: #2A2A2A !important; color: #F5F5F5 !important; }

  /* ══════════════════════════════════════════
     AUTH BUTTON
  ══════════════════════════════════════════ */
  .swagger-ui .auth-wrapper .authorize {
    background: transparent !important;
    border: 1.5px solid #CCFF00 !important;
    border-radius: 7px;
    color: #CCFF00 !important;
    font-size: 13px;
    font-weight: 600;
    padding: 7px 16px;
    transition: all 0.18s;
    letter-spacing: 0.02em;
  }
  .swagger-ui .auth-wrapper .authorize:hover {
    background: #CCFF00 !important;
    color: #111111 !important;
    box-shadow: 0 0 20px rgba(204,255,0,0.3);
  }
  .swagger-ui .auth-wrapper .authorize svg { fill: #CCFF00 !important; }

  /* ══════════════════════════════════════════
     FILTER / SEARCH
  ══════════════════════════════════════════ */
  .swagger-ui .operation-filter-input {
    background: #2A2A2A !important;
    border: 1.5px solid #3a3a3a !important;
    border-radius: 8px !important;
    color: #F5F5F5 !important;
    font-size: 13px !important;
    padding: 10px 14px !important;
    width: 100%;
    transition: border-color 0.15s, box-shadow 0.15s;
  }
  .swagger-ui .operation-filter-input::placeholder { color: rgba(245,245,245,0.3) !important; }
  .swagger-ui .operation-filter-input:focus {
    border-color: #CCFF00 !important;
    outline: none !important;
    box-shadow: 0 0 0 3px rgba(204,255,0,0.18) !important;
  }

  /* ══════════════════════════════════════════
     TAGS (SECTION HEADERS)
  ══════════════════════════════════════════ */
  .swagger-ui .opblock-tag {
    background: #1a1a1a !important;
    border: 1px solid #2A2A2A !important;
    border-radius: 10px !important;
    color: #CCFF00 !important;
    font-size: 14px !important;
    font-weight: 600 !important;
    margin: 10px 0 4px !important;
    padding: 13px 18px !important;
    transition: all 0.18s;
    box-shadow: 0 1px 4px rgba(0,0,0,0.4);
  }
  .swagger-ui .opblock-tag:hover {
    background: #2A2A2A !important;
    border-color: #CCFF00 !important;
    box-shadow: 0 0 0 3px rgba(204,255,0,0.12) !important;
  }
  .swagger-ui .opblock-tag small {
    color: rgba(245,245,245,0.4) !important;
    font-size: 12px;
    font-weight: 400;
    margin-left: 8px;
  }
  .swagger-ui .opblock-tag-section { margin-bottom: 10px; }
  .swagger-ui .opblock-tag-section h4 span { color: rgba(245,245,245,0.4) !important; }

  /* ══════════════════════════════════════════
     OPERATION BLOCKS
  ══════════════════════════════════════════ */
  .swagger-ui .opblock {
    border-radius: 8px !important;
    box-shadow: none !important;
    margin: 4px 0 !important;
    overflow: hidden;
    transition: box-shadow 0.18s, border-color 0.18s;
  }
  .swagger-ui .opblock:hover { box-shadow: 0 4px 20px rgba(0,0,0,0.5) !important; }
  .swagger-ui .opblock-summary { padding: 11px 18px; cursor: pointer; }
  .swagger-ui .opblock-summary-method {
    border-radius: 5px !important;
    font-size: 11px !important;
    font-weight: 700 !important;
    min-width: 66px;
    padding: 5px 8px !important;
    text-align: center;
    color: #FFFFFF !important;
  }
  .swagger-ui .opblock-summary-path {
    color: #FFFFFF !important;
    font-family: 'JetBrains Mono', 'Fira Code', monospace;
    font-size: 13px;
    font-weight: 500;
  }
  .swagger-ui .opblock-summary-path span { color: #FFFFFF !important; }
  .swagger-ui .opblock-summary-path__deprecated { text-decoration: line-through; }
  .swagger-ui .opblock-summary-description { color: #FFFFFF !important; font-size: 12px; }

  /* GET */
  .swagger-ui .opblock.opblock-get { background: #111111 !important; border: 1px solid #2A2A2A !important; }
  .swagger-ui .opblock.opblock-get .opblock-summary-method { background: #111111 !important; border: 1px solid #CCFF00 !important; }
  .swagger-ui .opblock.opblock-get.is-open { border-color: #2A2A2A !important; border-left-color: #CCFF00 !important; box-shadow: none !important; }
  /* POST */
  .swagger-ui .opblock.opblock-post { background: #111111 !important; border: 1px solid #2A2A2A !important; }
  .swagger-ui .opblock.opblock-post .opblock-summary-method { background: #111111 !important; border: 1px solid #CCFF00 !important; }
  .swagger-ui .opblock.opblock-post.is-open { border-color: #2A2A2A !important; border-left-color: #CCFF00 !important; box-shadow: none !important; }
  /* PUT */
  .swagger-ui .opblock.opblock-put { background: #111111 !important; border: 1px solid #2A2A2A !important; }
  .swagger-ui .opblock.opblock-put .opblock-summary-method { background: #111111 !important; border: 1px solid #CCFF00 !important; }
  .swagger-ui .opblock.opblock-put.is-open { border-color: #2A2A2A !important; border-left-color: #CCFF00 !important; box-shadow: none !important; }
  /* PATCH */
  .swagger-ui .opblock.opblock-patch { background: #111111 !important; border: 1px solid #2A2A2A !important; }
  .swagger-ui .opblock.opblock-patch .opblock-summary-method { background: #111111 !important; border: 1px solid #CCFF00 !important; }
  .swagger-ui .opblock.opblock-patch.is-open { border-color: #2A2A2A !important; border-left-color: #CCFF00 !important; box-shadow: none !important; }
  /* DELETE */
  .swagger-ui .opblock.opblock-delete { background: #111111 !important; border: 1px solid #2A2A2A !important; }
  .swagger-ui .opblock.opblock-delete .opblock-summary-method { background: #111111 !important; border: 1px solid #CCFF00 !important; }
  .swagger-ui .opblock.opblock-delete.is-open { border-color: #2A2A2A !important; border-left-color: #CCFF00 !important; box-shadow: none !important; }

  /* ══════════════════════════════════════════
     EXPANDED BLOCK BODY
  ══════════════════════════════════════════ */
  .swagger-ui .opblock-body { background: #1a1a1a !important; }
  .swagger-ui .opblock-section-header {
    background: #2A2A2A !important;
    border-bottom: 1px solid #333 !important;
    padding: 10px 18px !important;
  }
  .swagger-ui .opblock-section-header label {
    color: rgba(245,245,245,0.45) !important;
    font-size: 11px !important;
    font-weight: 700 !important;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }
  .swagger-ui .opblock-description-wrapper,
  .swagger-ui .opblock-external-docs-wrapper { padding: 14px 20px; }
  .swagger-ui .opblock-description-wrapper p { color: #F5F5F5 !important; font-size: 13px; margin: 0; }

  /* ══════════════════════════════════════════
     PARAMETERS
  ══════════════════════════════════════════ */
  .swagger-ui table thead tr th {
    background: #2A2A2A !important;
    border-bottom: 1px solid #333 !important;
    color: rgba(245,245,245,0.45) !important;
    font-size: 10px !important;
    font-weight: 700 !important;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    padding: 10px 18px;
  }
  .swagger-ui table tbody tr td {
    background: #1a1a1a !important;
    border-bottom: 1px solid #2A2A2A !important;
    color: #F5F5F5 !important;
    font-size: 13px;
    padding: 10px 18px;
    vertical-align: top;
  }
  .swagger-ui .parameter__name {
    color: #FFFFFF !important;
    font-family: 'JetBrains Mono', monospace;
    font-size: 13px;
    font-weight: 600;
  }
  .swagger-ui .parameter__type { color: #CCFF00 !important; font-size: 11px; font-weight: 500; }
  .swagger-ui .parameter__in { color: rgba(245,245,245,0.4) !important; font-size: 11px; font-style: italic; }
  .swagger-ui .parameter__deprecated { opacity: 0.4; }
  .swagger-ui .parameters-container { background: #1a1a1a !important; }
  .swagger-ui .parameters-col_description input[type=text] {
    background: #2A2A2A !important;
    color: #F5F5F5 !important;
    border-color: #3a3a3a !important;
  }

  /* ══════════════════════════════════════════
     RESPONSES
  ══════════════════════════════════════════ */
  .swagger-ui .tab { background: transparent !important; }
  .swagger-ui .tab li,
  .swagger-ui .tab li button {
    color: rgba(245,245,245,0.4) !important;
    font-size: 12px !important;
    padding: 6px 14px;
    cursor: pointer;
    border: none !important;
    border-bottom: 2px solid transparent !important;
    border-radius: 0 !important;
    transition: all 0.15s;
    background: transparent !important;
    box-shadow: none !important;
    outline: none !important;
  }
  .swagger-ui .tab li.active,
  .swagger-ui .tab li.active button {
    color: #CCFF00 !important;
    border-bottom: 2px solid #CCFF00 !important;
    font-weight: 600;
    background: transparent !important;
    box-shadow: none !important;
  }
  .swagger-ui .tab li:hover,
  .swagger-ui .tab li:hover button { color: #F5F5F5 !important; background: transparent !important; }
  .swagger-ui .response-col_status { color: #FFFFFF !important; font-family: 'JetBrains Mono', monospace; font-weight: 700; font-size: 14px; }
  .swagger-ui .response-col_description { color: #F5F5F5 !important; }
  .swagger-ui .response-col_links { color: rgba(245,245,245,0.4) !important; }
  .swagger-ui table.responses-table tr.response td {
    border-bottom: 1px solid #2A2A2A !important;
    background: #1a1a1a !important;
  }
  .swagger-ui .responses-inner { background: #1a1a1a !important; padding: 12px !important; }
  .swagger-ui .responses-inner h4,
  .swagger-ui .responses-inner h5 {
    color: rgba(245,245,245,0.4) !important;
    font-size: 11px !important;
    font-weight: 700 !important;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }
  .swagger-ui .live-responses-table .response td { background: #1a1a1a !important; color: #F5F5F5 !important; }

  /* ══════════════════════════════════════════
     CODE / JSON BLOCKS
  ══════════════════════════════════════════ */
  .swagger-ui .microlight,
  .swagger-ui pre.microlight {
    background: #111111 !important;
    border: 1px solid #2A2A2A !important;
    border-radius: 8px;
    color: #CCFF00 !important;
    font-family: 'JetBrains Mono', 'Fira Code', monospace !important;
    font-size: 12px !important;
    line-height: 1.7;
    padding: 14px 18px !important;
  }
  .swagger-ui .highlight-code { background: #111111 !important; border-radius: 8px; }
  .swagger-ui .highlight-code > .microlight { border: none !important; }
  .swagger-ui .curl-command { background: #111111 !important; }

  /* ══════════════════════════════════════════
     INPUTS & TEXTAREAS
  ══════════════════════════════════════════ */
  .swagger-ui input[type=text],
  .swagger-ui input[type=email],
  .swagger-ui input[type=file],
  .swagger-ui input[type=password],
  .swagger-ui textarea,
  .swagger-ui select {
    background: #2A2A2A !important;
    border: 1.5px solid #3a3a3a !important;
    border-radius: 7px;
    color: #F5F5F5 !important;
    font-size: 13px;
    padding: 9px 12px;
    transition: border-color 0.15s, box-shadow 0.15s;
  }
  .swagger-ui input::placeholder,
  .swagger-ui textarea::placeholder { color: rgba(245,245,245,0.3) !important; }
  .swagger-ui input:focus,
  .swagger-ui textarea:focus,
  .swagger-ui select:focus {
    border-color: #CCFF00 !important;
    outline: none !important;
    box-shadow: 0 0 0 3px rgba(204,255,0,0.18) !important;
  }

  /* ══════════════════════════════════════════
     BUTTONS
  ══════════════════════════════════════════ */
  .swagger-ui .btn {
    border-radius: 7px;
    font-size: 13px;
    font-weight: 600;
    padding: 8px 18px;
    transition: all 0.18s;
    cursor: pointer;
    letter-spacing: 0.02em;
  }
  .swagger-ui .btn.execute {
    background: #CCFF00 !important;
    border-color: #CCFF00 !important;
    color: #111111 !important;
  }
  .swagger-ui .btn.execute:hover {
    background: #b8e600 !important;
    border-color: #b8e600 !important;
    box-shadow: 0 0 20px rgba(204,255,0,0.3);
  }
  .swagger-ui .btn.try-out__btn {
    background: transparent !important;
    border: 1.5px solid #3a3a3a !important;
    color: #F5F5F5 !important;
  }
  .swagger-ui .btn.try-out__btn:hover {
    border-color: #CCFF00 !important;
    color: #CCFF00 !important;
  }
  .swagger-ui .btn.cancel {
    background: transparent !important;
    border: 1.5px solid #dc2626 !important;
    color: #dc2626 !important;
  }
  .swagger-ui .btn.cancel:hover { background: rgba(220,38,38,0.08) !important; }
  .swagger-ui .btn.authorize {
    background: transparent !important;
    border: 1.5px solid #CCFF00 !important;
    color: #CCFF00 !important;
  }
  .swagger-ui .btn.authorize svg { fill: #CCFF00 !important; }
  .swagger-ui .btn-clear { color: rgba(245,245,245,0.4) !important; background: transparent !important; border: none !important; }

  /* ══════════════════════════════════════════
     MODELS (HIDDEN)
  ══════════════════════════════════════════ */
  .swagger-ui .models { display: none !important; }

  /* ══════════════════════════════════════════
     COPY TO CLIPBOARD
  ══════════════════════════════════════════ */
  .swagger-ui .copy-to-clipboard {
    background: #2A2A2A !important;
    border-radius: 5px;
    border: 1px solid #333 !important;
  }
  .swagger-ui .copy-to-clipboard button { color: rgba(245,245,245,0.4) !important; }
  .swagger-ui .copy-to-clipboard button:hover { color: #CCFF00 !important; }

  /* ══════════════════════════════════════════
     AUTH MODAL
  ══════════════════════════════════════════ */
  .swagger-ui .dialog-ux .modal-ux {
    background: #1a1a1a !important;
    border: 1px solid #2A2A2A !important;
    border-radius: 12px;
    box-shadow: 0 16px 64px rgba(0,0,0,0.7);
  }
  .swagger-ui .dialog-ux .modal-ux-header {
    background: #2A2A2A !important;
    border-bottom: 1px solid #333 !important;
    border-radius: 12px 12px 0 0;
    padding: 18px 24px !important;
  }
  .swagger-ui .dialog-ux .modal-ux-header h3 { color: #FFFFFF !important; font-size: 16px; font-weight: 700; margin: 0; }
  .swagger-ui .dialog-ux .modal-ux-content { background: #1a1a1a !important; padding: 20px 24px !important; }
  .swagger-ui .dialog-ux .modal-ux-content p,
  .swagger-ui .dialog-ux .modal-ux-content h4 { color: #F5F5F5 !important; }
  .swagger-ui .dialog-ux .modal-ux-content label {
    color: rgba(245,245,245,0.4) !important;
    font-size: 11px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.08em;
  }

  /* ══════════════════════════════════════════
     LOADING / ERRORS
  ══════════════════════════════════════════ */
  .swagger-ui .loading-container { background: #111111 !important; }
  .swagger-ui .errors-wrapper {
    background: rgba(220,38,38,0.08) !important;
    border: 1px solid rgba(220,38,38,0.3) !important;
    border-radius: 8px;
  }
  .swagger-ui .errors-wrapper .error { color: #f87171 !important; }

  /* ══════════════════════════════════════════
     MISC OVERRIDES
  ══════════════════════════════════════════ */
  .swagger-ui .expand-methods svg,
  .swagger-ui .expand-operation svg { fill: rgba(245,245,245,0.4) !important; }
  .swagger-ui .arrow { fill: rgba(245,245,245,0.4) !important; }
  .swagger-ui .model { color: #F5F5F5 !important; }
  .swagger-ui .model-container { background: #1a1a1a !important; border-color: #2A2A2A !important; }

  /* Kill white focus ring on endpoint click */
  .swagger-ui .opblock-summary:focus,
  .swagger-ui .opblock-summary:focus-visible,
  .swagger-ui .opblock:focus,
  .swagger-ui .opblock:focus-within,
  .swagger-ui *:focus { outline: none !important; box-shadow: none !important; }
  .swagger-ui *:focus-visible { outline: none !important; }

  /* Hide OAS3 tag badge */
  .swagger-ui .info .title span,
  .swagger-ui .swagger-ui__version-stamp,
  .swagger-ui .info hgroup.main a.link { display: none !important; }
  .swagger-ui .opblock-tag-section .opblock-tag span[style],
  span.version { display: none !important; }

  /* ══════════════════════════════════════════
     SCROLLBAR
  ══════════════════════════════════════════ */
  * { scrollbar-width: thin; scrollbar-color: #3a3a3a #111111; }
  ::-webkit-scrollbar { width: 5px; height: 5px; }
  ::-webkit-scrollbar-track { background: #111111; }
  ::-webkit-scrollbar-thumb { background: #3a3a3a; border-radius: 3px; }
  ::-webkit-scrollbar-thumb:hover { background: rgba(245,245,245,0.3); }
`;

export const SWAGGER_OPTIONS = {
  persistAuthorization: true,
  docExpansion: 'none',
  filter: true,
  displayRequestDuration: true,
  tryItOutEnabled: true,
  tagsSorter: 'alpha',
  operationsSorter: 'alpha',
};
