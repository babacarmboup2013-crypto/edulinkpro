import React, { useEffect, useRef, useState } from 'react';
import ChesterWidget from './components/Chester.jsx';

/* ================================================================
   EduLink Pro — Page d'accueil
   ----------------------------------------------------------------
   Design system inspiré de la charte du logo :
   badge bleu nuit (#020617), anneau blanc, dot cyan (#22d3ee).
   Typographie : Inter. Grille 8px. Bento grid.
   ================================================================ */

const BRAND = {
  green900: '#020617',
  green800: '#0f172a',
  green700: '#1e293b',
  green600: '#25476a',
  green500: '#22d3ee',
  green50:  '#f0f4f8',
  gold:     '#d4a017',
  goldSoft: '#fef9e7',
  ink:      '#0f172a',
  body:     '#475569',
  muted:    '#64748b',
  line:     '#e2e8f0',
  white:    '#ffffff',
};

const css = `
@keyframes edlReveal{from{opacity:0;transform:translateY(90px)}to{opacity:1;transform:none}}
@keyframes edlFloat{0%,100%{transform:translateY(0)}50%{transform:translateY(-10px)}}
@keyframes edlDraw{from{stroke-dashoffset:320}to{stroke-dashoffset:0}}

.edl{--g900:${BRAND.green900};--g800:${BRAND.green800};--g700:${BRAND.green700};--g600:${BRAND.green600};--g500:${BRAND.green500};--g50:${BRAND.green50};--gold:${BRAND.gold};--goldsoft:${BRAND.goldSoft};--ink:${BRAND.ink};--body:${BRAND.body};--muted:${BRAND.muted};--line:${BRAND.line};--white:#fff;
  font-family:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:var(--white);color:var(--ink);
  -webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility;line-height:1.6;min-height:100vh;overflow-x:hidden}
.edl *{box-sizing:border-box;margin:0;padding:0}
.edl img{display:block;max-width:100%}
.edl button{font-family:inherit;cursor:pointer}
.edl a{color:inherit}
.edl-wrap{max-width:1180px;margin:0 auto;padding:0 28px}
.edl [data-reveal]{opacity:0;animation:edlReveal .8s cubic-bezier(.16,1,.3,1) forwards}

/* ---------- Nav ---------- */
.edl-nav{position:sticky;top:0;z-index:50;background:rgba(255,255,255,.86);backdrop-filter:blur(14px);border-bottom:1px solid var(--line);transition:box-shadow .3s}
.edl-nav.scrolled{box-shadow:0 10px 30px -18px rgba(2,6,23,.28)}
.edl-nav-in{max-width:1180px;margin:0 auto;padding:0 28px;height:88px;display:flex;align-items:center;justify-content:space-between;gap:24px}
.edl-brand{display:flex;align-items:center;gap:12px;text-decoration:none}
.edl-brand-name{display:flex;flex-direction:column;line-height:1.15}
.edl-brand-name b{font-size:1.2rem;font-weight:800;letter-spacing:-.02em;color:var(--ink)}
.edl-brand-title{display:flex;align-items:center;gap:7px}
.edl-brand-title em{font-style:normal;font-size:.66rem;font-weight:800;color:#fff;background:linear-gradient(135deg,#f4d97e,#d4a017);padding:2px 7px;border-radius:6px;letter-spacing:.03em;box-shadow:0 2px 10px rgba(212,160,23,.5)}
.edl-brand-name small{font-size:.72rem;font-weight:600;color:var(--muted);margin-top:3px}
.edl-navlinks{display:flex;align-items:center;gap:6px}
.edl-navlinks a{position:relative;padding:9px 14px;font-size:.9rem;font-weight:600;color:var(--muted);text-decoration:none;border-radius:9px;transition:color .2s,background .2s}
.edl-navlinks a:hover{color:var(--g700);background:var(--g50)}
.edl-navdrop{position:relative}
.edl-navdrop-trigger{display:flex;align-items:center;gap:6px;padding:9px 14px;font-size:.9rem;font-weight:600;color:var(--muted);background:none;border:none;border-radius:9px;font-family:inherit;cursor:pointer;transition:color .2s,background .2s}
.edl-navdrop-trigger:hover{color:var(--g700);background:var(--g50)}
.edl-navdrop-trigger svg{transition:transform .25s}
.edl-navdrop.open .edl-navdrop-trigger svg{transform:rotate(180deg)}
.edl-navdrop-menu{position:absolute;top:calc(100% + 10px);left:0;min-width:230px;background:#fff;border:2px solid var(--line);border-radius:14px;box-shadow:0 30px 60px -30px rgba(2,6,23,.35);padding:8px;opacity:0;visibility:hidden;transform:translateY(10px);transition:.25s cubic-bezier(.16,1,.3,1);z-index:60}
.edl-navdrop.open .edl-navdrop-menu,.edl-navdrop:hover .edl-navdrop-menu{opacity:1;visibility:visible;transform:none}
.edl-navdrop-menu a{display:block;padding:10px 14px;border-radius:9px;font-size:.9rem;font-weight:600;color:var(--muted);text-decoration:none;transition:.15s}
.edl-navdrop-menu a:hover{color:var(--g700);background:var(--g50)}
.edl-nav-cta{display:flex;align-items:center;margin-left:10px}
.edl-nav-cta .edl-btn{padding:15px 32px;font-size:1rem;border-radius:13px}
.edl-nav-cta .edl-btn:hover{transform:translateY(-2px)}
.edl-hamb{display:none}

/* ---------- Button ---------- */
.edl-btn{display:inline-flex;align-items:center;justify-content:center;gap:9px;border:2px solid var(--gold);font-weight:700;font-size:.92rem;border-radius:11px;padding:13px 22px;color:#fff;background:var(--g900);box-shadow:0 8px 20px -10px rgba(2,6,23,.55);transition:transform .18s ease,box-shadow .25s ease,background .2s ease;text-decoration:none;white-space:nowrap}
.edl-btn:hover{transform:translateY(-2px);box-shadow:0 16px 30px -12px rgba(2,6,23,.5);background:var(--g800)}
.edl-btn:active{transform:translateY(0)}
.edl-btn--ghost{background:#fff;color:var(--g800);box-shadow:none;border:2px solid var(--gold)}
.edl-btn--ghost:hover{background:var(--g50);border-color:var(--gold);box-shadow:none}
.edl-btn--lg{padding:16px 30px;font-size:1rem;border-radius:13px}

/* ---------- Hero ---------- */
.edl-hero{position:relative;background:
  radial-gradient(900px 380px at 88% -10%,rgba(16,163,116,.10),transparent 60%),
  radial-gradient(700px 320px at 0% 100%,rgba(212,160,23,.08),transparent 55%);
  border-bottom:1px solid var(--line);overflow:hidden}
.edl-hero-watermark{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;pointer-events:none;z-index:0}
.edl-hero-watermark img{width:720px;height:auto;max-width:90vw;opacity:.08}

.edl-watermark{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;pointer-events:none;z-index:0;overflow:hidden}
.edl-watermark img{width:760px;height:auto;max-width:92vw;opacity:.06}
.edl-watermark + .edl-wrap,.edl-watermark + .edl-wrap > *{position:relative;z-index:1}
.edl-cardwm{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;pointer-events:none;z-index:0;overflow:hidden}
.edl-cardwm img{width:340px;height:auto;max-width:70%;opacity:.08}
.edl-feat .edl-cardwm ~ *,.edl-sec .edl-cardwm ~ *{position:relative;z-index:1}
.edl-hero-grid{display:grid;grid-template-columns:1.02fr .98fr;gap:64px;align-items:center;padding:92px 28px 100px}
.edl-eyebrow{display:inline-flex;align-items:center;gap:10px;font-size:.76rem;font-weight:700;letter-spacing:.16em;text-transform:uppercase;color:var(--g700);background:var(--g50);border:2px solid var(--gold);padding:8px 14px;border-radius:999px}
.edl-eyebrow::before{content:"";width:7px;height:7px;border-radius:50%;background:var(--gold);box-shadow:0 0 0 3px rgba(212,160,23,.18)}
.edl-hero h1{font-size:clamp(2.4rem,4.6vw,3.6rem);font-weight:800;letter-spacing:-.035em;line-height:1.06;margin:22px 0 22px;color:var(--ink)}
.edl-hero h1 .g{color:var(--g600)}
.edl-hero h1 .gold{color:var(--gold)}
.edl-hero .lead{font-size:1.12rem;color:var(--body);max-width:560px;margin-bottom:34px}
.edl-hero-cta{display:flex;gap:14px;flex-wrap:wrap;align-items:center;margin-bottom:44px}
.edl-hero-metrics{display:flex;gap:0;border-top:1px solid var(--line);padding-top:26px}
.edl-metric{flex:1;padding-right:26px}
.edl-metric + .edl-metric{border-left:1px solid var(--line);padding-left:26px}
.edl-metric .n{font-size:1.55rem;font-weight:800;letter-spacing:-.02em;color:var(--g800)}
.edl-metric .l{font-size:.8rem;color:var(--muted);font-weight:600;margin-top:3px}

/* Hero visual */
.edl-visual{position:relative;padding:10px}
.edl-visual-ring{position:absolute;inset:-26px;pointer-events:none}
.edl-visual-ring svg{width:100%;height:100%}
.edl-browser{position:relative;background:#fff;border:1px solid var(--line);border-radius:18px;box-shadow:0 40px 90px -40px rgba(2,6,23,.4);overflow:hidden}
.edl-browser-bar{display:flex;align-items:center;gap:8px;height:44px;padding:0 16px;border-bottom:1px solid var(--line);background:linear-gradient(180deg,#fbfdfc,#f4f8f6)}
.edl-browser-bar i{width:11px;height:11px;border-radius:50%;display:block}
.edl-browser-bar i:nth-child(1){background:#ed6a5e}
.edl-browser-bar i:nth-child(2){background:#f2bd5a}
.edl-browser-bar i:nth-child(3){background:#61c789}
.edl-browser-bar .url{margin-left:12px;flex:1;max-width:260px;height:24px;border-radius:7px;background:#eaf1ec;font-size:.74rem;color:var(--muted);display:flex;align-items:center;padding:0 12px;letter-spacing:.02em}
.edl-browser img{width:100%;aspect-ratio:16/11;object-fit:cover;object-position:top;display:block}
.edl-float-chip{position:absolute;bottom:-22px;left:-8px;background:#fff;border:1px solid var(--line);border-radius:14px;box-shadow:0 20px 44px -18px rgba(2,6,23,.35);padding:14px 18px;display:flex;align-items:center;gap:12px;animation:edlFloat 6s ease-in-out infinite}
.edl-float-chip .ic{width:40px;height:40px;border-radius:11px;background:var(--g50);color:var(--g700);border:2px solid var(--gold);display:flex;align-items:center;justify-content:center}
.edl-float-chip .t{font-weight:700;font-size:.86rem;color:var(--ink);line-height:1.2}
.edl-float-chip .s{font-size:.74rem;color:var(--muted)}

/* ---------- Sections ---------- */
.edl-section{padding:96px 0}
.edl-sec-head{max-width:720px;margin:0 0 56px}
.edl-sec-head.center{margin:0 auto 56px;text-align:center}
.edl-sec-head .tag{display:inline-flex;align-items:center;gap:10px;font-size:.76rem;font-weight:700;letter-spacing:.16em;text-transform:uppercase;color:var(--gold);background:var(--goldsoft);border:1px solid rgba(212,160,23,.2);padding:8px 14px;border-radius:999px;margin-bottom:18px}
.edl-sec-head .tag::before{content:"";width:7px;height:7px;border-radius:50%;background:var(--gold)}
.edl-sec-head h2{font-size:clamp(1.9rem,3.4vw,2.6rem);font-weight:800;letter-spacing:-.03em;color:var(--ink);line-height:1.12;margin-bottom:16px}
.edl-sec-head p{font-size:1.05rem;color:var(--body)}

/* ---------- Bento features ---------- */
.edl-bento{display:flex;flex-direction:column;gap:22px}
.edl-feat{position:relative;background:#fff;border:1px solid var(--line);border-radius:22px;overflow:hidden;transition:transform .3s cubic-bezier(.16,1,.3,1),box-shadow .3s,border-color .3s}
.edl-feat:hover{transform:translateY(-4px);box-shadow:0 28px 60px -30px rgba(2,6,23,.35);border-color:rgba(30,64,175,.3)}
.edl-feat--wide{display:grid;grid-template-columns:1.05fr 1fr}
.edl-feat--dark{background:var(--g900);border-color:transparent}
.edl-feat-media{position:relative;background:var(--g900);overflow:hidden}
.edl-feat-media img{width:100%;height:100%;object-fit:cover;object-position:top;transition:transform .6s cubic-bezier(.16,1,.3,1)}
.edl-feat:hover .edl-feat-media img{transform:scale(1.03)}
.edl-feat-media .grow{position:absolute;right:18px;bottom:18px;width:34px;height:34px;border-radius:50%;background:rgba(255,255,255,.92);color:var(--g800);display:flex;align-items:center;justify-content:center;opacity:0;transform:translateY(6px);transition:.3s}
.edl-feat:hover .edl-feat-media .grow{opacity:1;transform:none}
.edl-feat-body{padding:30px}
.edl-feat--wide .edl-feat-body{display:flex;flex-direction:column;justify-content:center;padding:40px}
.edl-feat--square{min-height:100%}
.edl-feat--square .edl-feat-media{aspect-ratio:16/10}
.edl-feat--wide .edl-feat-media{min-height:340px}
.edl-feat--dark .edl-feat-media{background:linear-gradient(135deg,transparent,rgba(0,0,0,.15))}
.edl-feat-body .ic{width:46px;height:46px;border-radius:12px;background:var(--g50);color:var(--g700);display:flex;align-items:center;justify-content:center;margin-bottom:18px}
.edl-feat--dark .edl-feat-body .ic{background:rgba(255,255,255,.12);color:#ffe4a1}
.edl-feat-body h3{font-size:1.22rem;font-weight:800;letter-spacing:-.015em;margin-bottom:10px;color:var(--ink)}
.edl-feat--dark .edl-feat-body h3{color:#fff}
.edl-feat-body p{font-size:.95rem;color:var(--body);line-height:1.65}
.edl-feat--dark .edl-feat-body p{color:#cfe6da}
.edl-pillrow{display:flex;flex-wrap:wrap;gap:8px;margin-top:20px}
.edl-pill{font-size:.74rem;font-weight:700;color:var(--g800);background:var(--g50);padding:6px 12px;border-radius:999px;border:1px solid rgba(30,64,175,.14)}
.edl-feat--dark .edl-pill{background:rgba(255,255,255,.1);color:#ffe9b8;border-color:rgba(255,255,255,.14)}
.edl-bento-grid{display:grid;grid-template-columns:1fr 1fr;gap:22px}

/* ---------- V1 band ---------- */
.edl-band{background:linear-gradient(135deg,var(--g900) 20%,var(--g800));border-radius:26px;padding:64px;color:#fff;position:relative;overflow:hidden}
.edl-band::after{content:"";position:absolute;right:-90px;top:-90px;width:340px;height:340px;border-radius:50%;border:70px solid rgba(255,255,255,.05);pointer-events:none}
.edl-band-grid{display:grid;grid-template-columns:1.05fr .95fr;gap:60px;align-items:center;position:relative;z-index:1}
.edl-band .ey{display:inline-flex;align-items:center;gap:10px;font-size:.76rem;font-weight:700;letter-spacing:.16em;text-transform:uppercase;color:#f5dfae;background:rgba(212,160,23,.18);border:1px solid rgba(247,220,160,.3);padding:8px 14px;border-radius:999px;margin-bottom:20px}
.edl-band .ey::before{content:"";width:7px;height:7px;border-radius:50%;background:#f5dfae}
.edl-band h2{font-size:clamp(1.8rem,3vw,2.4rem);font-weight:800;letter-spacing:-.03em;line-height:1.12;margin-bottom:18px}
.edl-band p{color:#d3e7dc;font-size:1.03rem;margin-bottom:32px;max-width:520px}
.edl-list{list-style:none;display:flex;flex-direction:column;gap:16px}
.edl-list li{display:flex;gap:14px;align-items:flex-start;font-size:.98rem;color:#eaf3ee}
.edl-list li b{color:#fff}
.edl-list .tick{width:26px;height:26px;flex-shrink:0;border-radius:50%;background:rgba(212,160,23,.22);color:#f5dfae;display:flex;align-items:center;justify-content:center;margin-top:1px}
.edl-band-stats{display:grid;grid-template-columns:1fr 1fr;gap:16px}
.edl-band-stat{background:rgba(255,255,255,.07);border:1px solid rgba(255,255,255,.12);border-radius:18px;padding:22px}
.edl-band-stat .n{font-size:1.9rem;font-weight:800;letter-spacing:-.02em;color:#f5dfae}
.edl-band-stat .t{font-weight:700;font-size:.95rem;margin-top:4px}
.edl-band-stat .d{font-size:.82rem;color:#b9d6c7;margin-top:2px}

/* ---------- Security ---------- */
.edl-sec-cards{display:grid;grid-template-columns:repeat(3,1fr);gap:22px}
.edl-sec{background:#fff;border:2px solid #d4e0da;border-radius:20px;padding:30px;transition:transform .3s,box-shadow .3s,border-color .3s}
.edl-sec:hover{transform:translateY(-4px);box-shadow:0 24px 50px -26px rgba(2,6,23,.3);border-color:rgba(212,160,23,.3)}
.edl-sec .ic{width:48px;height:48px;border-radius:13px;background:var(--goldsoft);color:var(--gold);display:flex;align-items:center;justify-content:center;margin-bottom:18px}
.edl-sec h3{font-size:1.08rem;font-weight:800;margin-bottom:10px}
.edl-sec p{font-size:.92rem;color:var(--body);line-height:1.6}

/* ---------- CTA ---------- */
.edl-cta{background:var(--g900);position:relative;overflow:hidden;padding:92px 0}
.edl-cta::before{content:"";position:absolute;inset:0;background:
  radial-gradient(700px 300px at 15% 120%,rgba(212,160,23,.25),transparent 60%),
  radial-gradient(800px 360px at 88% -30%,rgba(22,163,116,.25),transparent 55%)}
.edl-cta-in{position:relative;z-index:1;text-align:center;max-width:640px;margin:0 auto}
.edl-cta h2{font-size:clamp(1.9rem,3.4vw,2.6rem);font-weight:800;letter-spacing:-.03em;line-height:1.12;color:#fff;margin-bottom:16px}
.edl-cta p{color:#c4ddce;font-size:1.05rem;margin-bottom:34px}
.edl-cta .edl-btn--gold{background:linear-gradient(135deg,#c99a3d,var(--gold));box-shadow:0 14px 30px -12px rgba(0,0,0,.5)}
.edl-cta .edl-btn--gold:hover{background:linear-gradient(135deg,#dbb052,#c99a3d);transform:translateY(-2px)}

/* ---------- Or royal, brillant ---------- */
.edl-sec-head .tag{color:#cf9f1e;text-shadow:0 1px 0 rgba(255,255,255,.55)}
.edl-sec-head .tag::before{background:#e7b439;box-shadow:0 0 8px rgba(231,180,57,.75)}
.edl-band .ey{color:#f2d478;text-shadow:0 0 16px rgba(242,212,120,.4)}
.edl-band .ey::before{background:#f2d478;box-shadow:0 0 9px rgba(242,212,120,.9)}
.edl-band .tick{color:#f2d478;margin-top:1px}
.edl-band .tick svg{filter:drop-shadow(0 0 5px rgba(242,212,120,.65))}
.edl-band-stat .n{color:#f2d478;text-shadow:0 0 20px rgba(242,212,120,.45)}
.edl-feat--dark .edl-feat-body .ic{color:#ffe4a1}
.edl-feat--dark .edl-pill{color:#ffe4a1;border-color:rgba(255,228,161,.3)}
.edl-footer .copy b{color:#f2d478;text-shadow:0 0 14px rgba(242,212,120,.4)}
.edl-cta .edl-btn--gold{background:linear-gradient(135deg,#f4d97e,#d4a017);border:2px solid #8a6b1d;box-shadow:0 14px 34px -12px rgba(0,0,0,.5),0 0 28px rgba(212,160,23,.45)}
.edl-cta .edl-btn--gold:hover{background:linear-gradient(135deg,#fae28c,#e7b439);transform:translateY(-2px);box-shadow:0 18px 40px -14px rgba(0,0,0,.55),0 0 36px rgba(250,226,140,.5)}

/* ---------- Contact ---------- */
.edl-contact{padding:96px 0}
.edl-contact-grid{display:grid;grid-template-columns:.85fr 1.15fr;gap:40px;align-items:stretch}
.edl-contact-info{display:flex;flex-direction:column;gap:20px}
.edl-contact-card{background:#fff;border:3px solid #c2d1ca;border-radius:18px;padding:26px;display:flex;gap:18px;align-items:flex-start;transition:transform .3s,box-shadow .3s;text-align:left}
.edl-contact-card:hover{transform:translateY(-3px);box-shadow:0 18px 40px -22px rgba(2,6,23,.28)}
.edl-contact-card .ic{width:50px;height:50px;flex-shrink:0;border-radius:13px;background:var(--g50);color:var(--g700);display:flex;align-items:center;justify-content:center}
.edl-contact-card h4{font-size:.98rem;font-weight:800;margin-bottom:4px}
.edl-contact-card p{font-size:.9rem;color:var(--body);line-height:1.6}
.edl-contact-card a{color:var(--g700);font-weight:700;text-decoration:none}
.edl-contact-card a:hover{text-decoration:underline}
.edl-form{background:#fff;border:3px solid #c2d1ca;border-radius:22px;padding:40px;box-shadow:0 30px 70px -40px rgba(2,6,23,.35)}
.edl-form h3{font-size:1.3rem;font-weight:800;letter-spacing:-.02em;margin-bottom:8px}
.edl-form .sub{color:var(--muted);font-size:.9rem;margin-bottom:26px}
.edl-field{display:flex;flex-direction:column;gap:8px;margin-bottom:18px}
.edl-field label{font-size:.82rem;font-weight:700;color:var(--ink)}
.edl-field input,.edl-field textarea,.edl-field select{border:2.5px solid #b8c9c0;border-radius:11px;padding:12px 14px;font-size:.95rem;font-family:inherit;color:var(--ink);background:#fff;transition:border-color .2s,box-shadow .2s;outline:none}
.edl-field input:focus,.edl-field textarea:focus,.edl-field select:focus{border-color:var(--g600);box-shadow:0 0 0 3px rgba(30,64,175,.12)}
.edl-field textarea{resize:vertical;min-height:110px}
.edl-form-row{display:grid;grid-template-columns:1fr 1fr;gap:16px}
.edl-form-ok{background:var(--g50);border:1px solid rgba(30,64,175,.25);color:var(--g800);padding:13px 16px;border-radius:11px;font-weight:700;font-size:.9rem;margin-bottom:16px;display:flex;align-items:center;gap:9px}

/* ---------- Footer ---------- */
.edl-footer{background:#06291e;color:#9fc3b1;padding:44px 0}
.edl-footer-in{max-width:1180px;margin:0 auto;padding:0 28px;display:flex;align-items:center;justify-content:space-between;gap:20px;flex-wrap:wrap}
.edl-footer-brand{display:flex;align-items:center;gap:12px}
.edl-footer-brand small{display:block;color:#7fa893;font-size:.8rem;margin-top:2px}
.edl-footer-links{display:flex;gap:8px}
.edl-footer-links a{padding:8px 12px;font-size:.88rem;font-weight:600;color:#a8c8b8;text-decoration:none;border-radius:8px;transition:.2s}
.edl-footer-links a:hover{color:#fff;background:rgba(255,255,255,.06)}
.edl-footer .copy{font-size:.82rem;color:#7fa893;width:100%;text-align:center;margin-top:22px}
.edl-footer .copy b{color:#f5dfae;font-weight:700}

/* ---------- Responsive ---------- */
@media(max-width:920px){
  .edl-hero-grid{grid-template-columns:1fr;gap:56px;padding:64px 28px 76px}
  .edl-editor-left{text-align:center}
  .edl-hero .lead{margin-left:auto;margin-right:auto}
  .edl-hero-cta{justify-content:center}
  .edl-feat--wide{grid-template-columns:1fr}
  .edl-feat--wide .edl-feat-media{min-height:220px}
  .edl-bento-grid{grid-template-columns:1fr}
  .edl-band-grid{grid-template-columns:1fr;gap:44px}
  .edl-band{padding:44px 30px}
  .edl-sec-cards{grid-template-columns:1fr 1fr}
  .edl-contact-grid{grid-template-columns:1fr}
  .edl-navlinks{display:flex;flex-direction:column;position:absolute;top:88px;left:0;right:0;background:#fff;padding:16px 24px 22px;border-bottom:1px solid var(--line);box-shadow:0 24px 40px -24px rgba(2,6,23,.3);gap:4px;transform:none}
  .edl-navlinks:not(.open){display:none}
  .edl-navlinks a{width:100%}
  .edl-navdrop{width:100%}
  .edl-navdrop-trigger{width:100%;justify-content:flex-start}
  .edl-navdrop-menu{position:static;min-width:0;border:1px solid var(--line);border-radius:10px;box-shadow:none;margin:4px 0 8px 10px;padding:4px;display:none;opacity:1;visibility:visible;transform:none;background:var(--g50)}
  .edl-navdrop.open .edl-navdrop-menu{display:block}
  .edl-nav-cta{width:100%;margin-top:8px}
  .edl-nav-cta .edl-btn{width:100%}
  .edl-hamb{display:flex}
  .edl-hero-metrics{margin-bottom:10px}
}
@media(max-width:600px){
  .edl-section{padding:72px 0}
  .edl-band{padding:38px 24px;border-radius:20px}
  .edl-band-stats{grid-template-columns:1fr}
  .edl-sec-cards{grid-template-columns:1fr}
  .edl-cta{padding:76px 0}
  .edl-form{padding:28px 22px}
  .edl-form-row{grid-template-columns:1fr}
  .edl-hero-metrics{flex-wrap:wrap;gap:18px 0}
  .edl-metric{flex:1 1 40%}
  .edl-metric + .edl-metric{border-left:none}
  .edl-footer-in{flex-direction:column;text-align:center}
}
@media(prefers-reduced-motion:reduce){
  .edl *{animation-duration:.001s!important;transition-duration:.001s!important}
  .edl [data-reveal]{opacity:1}
}

/* Chester (styles de support) */
@keyframes sygenopFade{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}
.sygenop-fade{animation:sygenopFade .25s ease-out}
`;

/* ---------- Icones (lucide-like, pleines) ---------- */
function Icon({ name, size = 24, color = 'currentColor', strokeWidth = 2 }) {
  const p = {
    dashboard: <><rect x="3" y="3" width="7" height="9" rx="1.5" /><rect x="14" y="3" width="7" height="5" rx="1.5" /><rect x="3" y="16" width="7" height="5" rx="1.5" /><rect x="14" y="12" width="7" height="9" rx="1.5" /></>,
    users: <><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M22 21v-2a4 4 0 0 0-3-3.87" /><path d="M16 3.13a4 4 0 0 1 0 7.75" /></>,
    book: <><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" /><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" /></>,
    chart: <><path d="M3 3v18h18" /><path d="M18 17V9" /><path d="M13 17V5" /><path d="M8 17v-3" /></>,
    check: <path d="M20 6 9 17l-5-5" strokeLinecap="round" strokeLinejoin="round" />,
    shield: <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />,
    wallet: <><rect x="2" y="5" width="20" height="14" rx="2" /><path d="M2 10h20" /><path d="M16 15h.01" /></>,
    award: <><circle cx="12" cy="8" r="6" /><path d="M15.5 13 17 22l-5-3-5 3 1.5-9" /></>,
    cloud: <path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9z" />,
    wifi: <><path d="M5 13a10 10 0 0 1 14 0" /><path d="M8.5 16.5a5 5 0 0 1 7 0" /><path d="M2 8.82a15 15 0 0 1 20 0" /><circle cx="12" cy="20" r="1" /></>,
    lock: <><rect x="5" y="11" width="14" height="9" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></>,
    phone: <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z" />,
    mail: <><rect x="2" y="4" width="20" height="16" rx="2" /><path d="m22 7-10 5L2 7" /></>,
    arrow: <><path d="M5 12h14" /><path d="m12 5 7 7-7 7" /></>,
    pause: <><rect x="6" y="4" width="4" height="16" rx="1" /><rect x="14" y="4" width="4" height="16" rx="1" /></>,
    backup: <><path d="M9.5 2A6.5 6.5 0 0 0 6 14.7" /><path d="M20 9.3A6.5 6.5 0 0 0 14.5 8H8" /><path d="M8 8 2 6l6-2" /></>,
  };
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {p[name] || p.arrow}
    </svg>
  );
}

export default function HomePage({ onEnter }) {
  const [open, setOpen] = useState(false);
  const [dnOpen, setDnOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  const [form, setForm] = useState({ nom: '', email: '', sujet: '', msg: '' });
  const [sent, setSent] = useState(false);
  const rootRef = useRef(null);

  const h = (e) => setForm((f) => ({ ...f, [e.target.name]: e.target.value }));
  const submitContact = (e) => {
    e.preventDefault();
    setSent(true);
    setForm({ nom: '', email: '', sujet: '', msg: '' });
    setTimeout(() => setSent(false), 6000);
  };

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 12);
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  useEffect(() => {
    const els = rootRef.current ? rootRef.current.querySelectorAll('[data-reveal]') : [];
    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((e) => {
          if (e.isIntersecting) {
            e.target.style.animationDelay = `${Math.min(e.target.dataset.delay || 0, 400)}ms`;
            e.target.style.opacity = '1';
            io.unobserve(e.target);
          }
        });
      },
      { threshold: 0.12, rootMargin: '0px 0px -60px 0px' }
    );
    els.forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, []);

  const onNav = (id) => {
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    setOpen(false);
  };

  const features = [
    { icon: 'users', img: 'illustrations/eleves-personnel.svg', title: 'Élèves & personnel', desc: "Écoles, classes, enseignants et élèves avec fiches complètes, photos et rôles de connexion distincts.", pills: ['Écoles', 'Classes', 'Rôles'] },
    { icon: 'book', img: 'illustrations/evaluations.svg', title: 'Évaluation & bulletins', desc: 'Notes, bulletins, relevés de moyennes et palmarès, avec export professionnel en un clic.', pills: ['Notes', 'Bulletins', 'Palmarès'] },
    { icon: 'wallet', img: 'illustrations/paiements.svg', title: 'Paiements & scolarité', desc: 'Pensions, frais et consommations suivis école par école, avec impayés et recettes en temps réel.', pills: ['Pensions', 'Recouvrement', 'Recettes'] },
    { icon: 'award', img: 'illustrations/import-export.svg', title: 'Import, export & migrations', desc: 'Reprenez vos données existantes, exportez bulletins et listes, et migrez entre écoles sans friction.', pills: ['Import', 'Export', 'Migrations'] },
  ];

  const vStats = [
    { n: '8+', t: 'Modules métier', d: 'Du tableau de bord aux paiements' },
    { n: '100%', t: 'Hors-ligne', d: 'Saisie locale puis synchro auto' },
    { n: '3', t: 'Niveaux d’accès', d: 'École, Groupe scolaire et Super Admin' },
    { n: '∞', t: 'Exports & sauvegarde', d: 'Fichiers, impressions et cloud' },
  ];

  const security = [
    { icon: 'shield', title: 'Protection des accès', desc: "Codes d'accès vérifiés côté serveur, jamais exposés dans le client, avec verrouillage anti-brute-force et historique des connexions." },
    { icon: 'cloud', title: 'Sauvegarde cloud', desc: 'Copie de sécurité sur Supabase avec reprise automatique des saisies locales à la reconnexion. Vos données ne se perdent jamais.' },
    { icon: 'wifi', title: 'Continuity hors-ligne', desc: 'Stockage persistant local : le travail continue sans réseau, sur n’importe quel appareil, sans aucune éviction de données.' },
  ];

  return (
    <>
      <style>{css}</style>
      <div className="edl" ref={rootRef}>
        {/* ===== NAV ===== */}
        <nav className={`edl-nav${scrolled ? ' scrolled' : ''}`}>
          <div className="edl-nav-in">
            <a href="#hero" className="edl-brand" onClick={(e) => { e.preventDefault(); window.scrollTo({ top: 0, behavior: 'smooth' }); }}>
              <img src={`${import.meta.env.BASE_URL}edulink-favicon.svg`} alt="EduLink Pro" style={{ width: 58, height: 58, borderRadius: 14, filter: 'drop-shadow(0 6px 18px rgba(2,6,23,.35))' }} />
              <span className="edl-brand-name">
                <span className="edl-brand-title">
                  <b>EduLink Pro</b>
                  <em>V1</em>
                </span>
                <small>La plateforme intelligente de gestion scolaire</small>
              </span>
            </a>
            <button className="edl-hamb" onClick={() => setOpen(!open)} aria-label="Menu" aria-expanded={open}>
              {open ? (
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M6 6l12 12M18 6 6 18" /></svg>
              ) : (
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M4 7h16M4 12h16M4 17h16" /></svg>
              )}
            </button>
            <div className={`edl-navlinks${open ? ' open' : ''}`}>
              <a href="#hero" onClick={(e) => { e.preventDefault(); window.scrollTo({ top: 0, behavior: 'smooth' }); setOpen(false); }}>Accueil</a>
              <a href="#fonctionnalites" onClick={(e) => { e.preventDefault(); onNav('fonctionnalites'); }}>Fonctionnalités</a>
              <div className={`edl-navdrop${dnOpen ? ' open' : ''}`}>
                <button type="button" className="edl-navdrop-trigger" onClick={() => setDnOpen(!dnOpen)}>
                  Ressources numériques
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="m6 9 6 6 6-6" /></svg>
                </button>
                <div className="edl-navdrop-menu">
                  <a href="#" onClick={(e) => { e.preventDefault(); setOpen(false); setDnOpen(false); }}>Documentation</a>
                  <a href="#" onClick={(e) => { e.preventDefault(); setOpen(false); setDnOpen(false); }}>Planifications</a>
                  <a href="#" onClick={(e) => { e.preventDefault(); setOpen(false); setDnOpen(false); }}>Fiches pédagogiques</a>
                </div>
              </div>
              <a href="#contact" onClick={(e) => { e.preventDefault(); onNav('contact'); }}>Contact</a>
              <div className="edl-nav-cta">
                <button type="button" className="edl-btn" onClick={onEnter}>
                  <Icon name="lock" size={16} color="currentColor" /> Se connecter
                </button>
              </div>
            </div>
          </div>
        </nav>

        {/* ===== HERO ===== */}
        <header id="hero" className="edl-hero">
          <div className="edl-hero-watermark" aria-hidden="true">
            <img src={`${import.meta.env.BASE_URL}edulink-favicon.svg`} alt="" />
          </div>
          <div className="edl-wrap edl-hero-grid" style={{ position: 'relative', zIndex: 1 }}>
            <div className="edl-editor-left" data-reveal>
              <h1>
                Pilotez <span className="g">vos écoles</span> où que vous soyez, <span className="gold">même hors-ligne</span>.
              </h1>
              <p className="lead">
                EduLink Pro centralise élèves, personnel, évaluations, paiements et vie scolaire pour
                les écoles, les groupes scolaires et les inspections — avec un accès sécurisé par codes.
              </p>
              <div className="edl-hero-cta">
                <button type="button" className="edl-btn edl-btn--lg" onClick={onEnter}>
                  <Icon name="lock" size={17} color="#fff" /> Se connecter
                </button>
                <button type="button" className="edl-btn edl-btn--lg edl-btn--ghost" onClick={() => onNav('fonctionnalites')}>
                  Découvrir les modules
                </button>
              </div>
              <div className="edl-hero-metrics">
                <div className="edl-metric"><div className="n">8+</div><div className="l">Modules métier</div></div>
                <div className="edl-metric"><div className="n">100%</div><div className="l">Hors-ligne</div></div>
                <div className="edl-metric"><div className="n">3</div><div className="l">Niveaux d’accès</div></div>
              </div>
            </div>

            <div className="edl-visual" data-reveal data-delay="120">
              <div className="edl-visual-ring" aria-hidden="true">
                <svg viewBox="0 0 400 400" fill="none">
                  <circle cx="200" cy="200" r="198" stroke="#020617" strokeOpacity=".12" strokeWidth="1.5" strokeDasharray="6 8" />
                  <circle cx="90" cy="80" r="9" fill="#d4a017" />
                  <circle cx="315" cy="320" r="6" fill="#22d3ee" />
                </svg>
              </div>
              <div className="edl-browser">
                <div className="edl-browser-bar">
                  <i /><i /><i />
                  <div className="url">app.edulinkpro.sn</div>
                </div>
                <img src={`${import.meta.env.BASE_URL}illustrations/tableau-de-bord.svg`} alt="Aperçu du tableau de bord EduLink Pro" />
              </div>
              <div className="edl-float-chip">
                <div className="ic"><Icon name="chart" size={20} color="#020617" /></div>
                <div>
                  <div className="t">Présences 96%</div>
                  <div className="s">suivi en temps réel</div>
                </div>
              </div>
            </div>
          </div>
        </header>

        {/* ===== MODULES (bento) ===== */}
        <section id="fonctionnalites" className="edl-section" style={{ position: 'relative', overflow: 'hidden' }}>
          <div className="edl-watermark" aria-hidden="true">
            <img src={`${import.meta.env.BASE_URL}edulink-favicon.svg`} alt="" />
          </div>
          <div className="edl-wrap">
            <div className="edl-sec-head" data-reveal>
              <span className="tag">Modules</span>
              <h2>Six briques métier, une seule plateforme</h2>
              <p>Chaque module couvre un pan du quotidien — de la saisie des notes au recouvrement des pensions, sans ressaisie.</p>
            </div>

            <div className="edl-bento">
              {/* Wide : tableau de bord */}
              <article className="edl-feat edl-feat--wide" data-reveal style={{ position: 'relative', overflow: 'hidden' }}>
                <div className="edl-cardwm" aria-hidden="true">
                  <img src={`${import.meta.env.BASE_URL}edulink-favicon.svg`} alt="" />
                </div>
                <div className="edl-feat-media">
                  <img src={`${import.meta.env.BASE_URL}illustrations/tableau-de-bord.svg`} alt="Tableau de bord EduLink Pro" loading="lazy" />
                  <span className="grow"><Icon name="arrow" size={16} /></span>
                </div>
                <div className="edl-feat-body">
                  <div className="ic"><Icon name="dashboard" size={22} color="#020617" /></div>
                  <h3>Tableau de bord intelligent</h3>
                  <p>Effectifs, présences, notes et paiements agrégés sur une vue globale, en temps réel, pour chaque école.</p>
                  <div className="edl-pillrow">
                    <span className="edl-pill">Effectifs</span>
                    <span className="edl-pill">Présences</span>
                    <span className="edl-pill">Synthèse</span>
                  </div>
                </div>
              </article>

              {/* Grille 2x2 */}
              <div className="edl-bento-grid">
                {features.slice(0, 2).map((f, i) => (
                  <article className="edl-feat edl-feat--square" key={f.title} data-reveal data-delay={i * 80} style={{ position: 'relative', overflow: 'hidden' }}>
                    <div className="edl-cardwm" aria-hidden="true">
                      <img src={`${import.meta.env.BASE_URL}edulink-favicon.svg`} alt="" />
                    </div>
                    <div className="edl-feat-media">
                      <img src={`${import.meta.env.BASE_URL}${f.img}`} alt={f.title} loading="lazy" />
                      <span className="grow"><Icon name="arrow" size={16} /></span>
                    </div>
                    <div className="edl-feat-body">
                      <div className="ic"><Icon name={f.icon} size={22} color="#020617" /></div>
                      <h3>{f.title}</h3>
                      <p>{f.desc}</p>
                      <div className="edl-pillrow">{f.pills.map((p) => <span className="edl-pill" key={p}>{p}</span>)}</div>
                    </div>
                  </article>
                ))}
              </div>

              <div className="edl-bento-grid">
                {features.slice(2).map((f, i) => (
                  <article className="edl-feat edl-feat--square" key={f.title} data-reveal data-delay={i * 80} style={{ position: 'relative', overflow: 'hidden' }}>
                    <div className="edl-cardwm" aria-hidden="true">
                      <img src={`${import.meta.env.BASE_URL}edulink-favicon.svg`} alt="" />
                    </div>
                    <div className="edl-feat-media">
                      <img src={`${import.meta.env.BASE_URL}${f.img}`} alt={f.title} loading="lazy" />
                      <span className="grow"><Icon name="arrow" size={16} /></span>
                    </div>
                    <div className="edl-feat-body">
                      <div className="ic"><Icon name={f.icon} size={22} color="#020617" /></div>
                      <h3>{f.title}</h3>
                      <p>{f.desc}</p>
                      <div className="edl-pillrow">{f.pills.map((p) => <span className="edl-pill" key={p}>{p}</span>)}</div>
                    </div>
                  </article>
                ))}
              </div>

              {/* Wide dark : sécurité */}
              <article className="edl-feat edl-feat--wide edl-feat--dark" data-reveal style={{ position: 'relative', overflow: 'hidden' }}>
                <div className="edl-cardwm" aria-hidden="true">
                  <img src={`${import.meta.env.BASE_URL}edulink-favicon.svg`} alt="" />
                </div>
                <div className="edl-feat-media">
                  <img src={`${import.meta.env.BASE_URL}illustrations/securite.svg`} alt="Sécurité multi-niveaux EduLink Pro" loading="lazy" />
                </div>
                <div className="edl-feat-body">
                  <div className="ic"><Icon name="shield" size={22} /></div>
                  <h3>Sécurité multi-niveaux</h3>
                  <p>Rôles école / groupe scolaire / Super Admin avec codes d’accès chiffrés, anti-brute-force et historique complet.</p>
                  <div className="edl-pillrow">
                    <span className="edl-pill">Rôles</span>
                    <span className="edl-pill">Codes</span>
                    <span className="edl-pill">Audit</span>
                  </div>
                </div>
              </article>
            </div>
          </div>
        </section>

        {/* ===== VERSION 1 ===== */}
        <section id="v1" className="edl-section" style={{ paddingTop: 0 }}>
          <div className="edl-wrap">
            <div className="edl-band" data-reveal style={{ overflow: 'hidden' }}>
              <div className="edl-watermark" aria-hidden="true">
                <img src={`${import.meta.env.BASE_URL}edulink-favicon.svg`} alt="" />
              </div>
              <div className="edl-band-grid">
                <div>
                  <span className="ey">Version 1 · Live</span>
                  <h2>Déployée, opérationnelle, fiable</h2>
                  <p>Une première version complète pensée pour tout de suite : sécurisée, rapide, et utilisable sans connexion sur n’importe quel appareil.</p>
                  <ul className="edl-list">
                    <li><span className="tick"><Icon name="check" size={15} color="#f5dfae" /></span><span><b>Saisie hors-ligne</b> — le travail continue sans réseau, sans rien perdre.</span></li>
                    <li><span className="tick"><Icon name="check" size={15} color="#f5dfae" /></span><span><b>Accès multi-rôles</b> — école, groupe scolaire et Super Admin, périmètres distincts.</span></li>
                    <li><span className="tick"><Icon name="check" size={15} color="#f5dfae" /></span><span><b>Anti-brute-force &amp; codes chiffrés</b> — vos accès restent sous contrôle.</span></li>
                    <li><span className="tick"><Icon name="check" size={15} color="#f5dfae" /></span><span><b>Autonome et léger</b> — installable comme une application sur tout appareil.</span></li>
                  </ul>
                </div>
                <div className="edl-band-stats">
                  {vStats.map((v) => (
                    <div className="edl-band-stat" key={v.t}>
                      <div className="n">{v.n}</div>
                      <div className="t">{v.t}</div>
                      <div className="d">{v.d}</div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* ===== SÉCURITÉ ===== */}
        <section id="securite" className="edl-section" style={{ paddingTop: 0, position: 'relative', overflow: 'hidden' }}>
          <div className="edl-watermark" aria-hidden="true">
            <img src={`${import.meta.env.BASE_URL}edulink-favicon.svg`} alt="" />
          </div>
          <div className="edl-wrap">
            <div className="edl-sec-head" data-reveal>
              <span className="tag">Sécurité &amp; fiabilité</span>
              <h2>Des données protégées à tous les niveaux</h2>
              <p>Conçue pour le terrain : connexion qui tient, accès contrôlés et aucune perte, même hors-ligne.</p>
            </div>
            <div className="edl-sec-cards">
              {security.map((s, i) => (
                <article className="edl-sec" key={s.title} data-reveal data-delay={i * 90} style={{ position: 'relative', overflow: 'hidden' }}>
                  <div className="edl-cardwm" aria-hidden="true">
                    <img src={`${import.meta.env.BASE_URL}edulink-favicon.svg`} alt="" />
                  </div>
                  <div className="edl-sec-in">
                    <div className="ic"><Icon name={s.icon} size={24} color="#d4a017" /></div>
                    <h3>{s.title}</h3>
                    <p>{s.desc}</p>
                  </div>
                </article>
              ))}
            </div>
          </div>
        </section>

        {/* ===== CONTACT ===== */}
        <section id="contact" className="edl-contact" style={{ paddingTop: 0, position: 'relative', overflow: 'hidden' }}>
          <div className="edl-watermark" aria-hidden="true">
            <img src={`${import.meta.env.BASE_URL}edulink-favicon.svg`} alt="" />
          </div>
          <div className="edl-wrap">
            <div className="edl-sec-head" data-reveal>
              <span className="tag">Contact</span>
              <h2>Une question, un accompagnement ?</h2>
              <p>Notre équipe vous répond pour l’installation, la formation ou toute demande spécifique à vos écoles.</p>
            </div>
            <div className="edl-contact-grid">
              <div className="edl-contact-info" data-reveal>
                <div className="edl-contact-card">
                  <div className="ic"><Icon name="phone" size={22} /></div>
                  <div>
                    <h4>Téléphone</h4>
                    <p><a href="tel:+221774170128">+221 77 417 01 28</a><br />Lun–Ven · 8h–18h</p>
                  </div>
                </div>
                <div className="edl-contact-card">
                  <div className="ic" style={{ background: '#e0f2fe', color: '#25476a' }}>
                    <svg width="22" height="22" viewBox="0 0 24 24" fill="#22d3ee" aria-hidden="true">
                      <path d="M12.04 2C6.58 2 2.13 6.45 2.13 11.91c0 1.75.46 3.45 1.32 4.95L2 22l5.25-1.38a9.9 9.9 0 0 0 4.78 1.22h.01c5.46 0 9.91-4.45 9.91-9.91C21.95 6.45 17.5 2 12.04 2m5.83 14.12c-.25.7-1.45 1.33-2 1.38-.53.05-1.03.24-3.46-.72-2.92-1.15-4.77-4.13-4.92-4.32-.14-.2-1.17-1.56-1.17-2.97 0-1.41.74-2.1 1-2.39.26-.28.57-.35.76-.35.19 0 .38 0 .54.01.18.01.41-.07.64.49.24.57.8 1.97.87 2.11.07.14.12.31.02.5-.1.19-.14.31-.29.48-.14.17-.3.38-.43.5-.14.14-.29.3-.12.58.17.28.74 1.22 1.59 1.97 1.09.97 2 1.27 2.29 1.42.29.14.45.12.62-.07.17-.2.72-.84.91-1.13.19-.29.38-.24.64-.14.26.09 1.66.78 1.95.93.28.14.47.21.54.33.07.11.07.66-.18 1.29z" />
                    </svg>
                  </div>
                  <div>
                    <h4>WhatsApp</h4>
                    <p><a href="https://wa.me/221774170128" target="_blank" rel="noopener noreferrer">+221 77 417 01 28</a><br />Réponse rapide par chat</p>
                  </div>
                </div>
                <div className="edl-contact-card">
                  <div className="ic"><Icon name="mail" size={22} /></div>
                  <div>
                    <h4>E-mail</h4>
                    <p><a href="mailto:mboup101@yahoo.fr">mboup101@yahoo.fr</a><br />Réponse sous 24 h ouvrées</p>
                  </div>
                </div>
                <div className="edl-contact-card">
                  <div className="ic"><Icon name="users" size={22} /></div>
                  <div>
                    <h4>Accompagnement</h4>
                    <p>Prise en main, formation des équipes et déploiement multi-écoles dans tout le pays.</p>
                  </div>
                </div>
              </div>

              <form className="edl-form" onSubmit={submitContact} data-reveal data-delay="100">
                <h3>Envoyez-nous un message</h3>
                <p className="sub">Remplissez le formulaire, nous reviendrons vers vous rapidement.</p>
                {sent && (
                  <div className="edl-form-ok"><Icon name="check" size={16} /> Merci ! Votre message a bien été envoyé.</div>
                )}
                <div className="edl-form-row">
                  <div className="edl-field">
                    <label htmlFor="c-nom">Nom complet</label>
                    <input id="c-nom" value={form.nom} onChange={h} name="nom" placeholder="Votre nom" required />
                  </div>
                  <div className="edl-field">
                    <label htmlFor="c-email">E-mail</label>
                    <input id="c-email" type="email" value={form.email} onChange={h} name="email" placeholder="vous@exemple.com" required />
                  </div>
                </div>
                <div className="edl-field">
                  <label htmlFor="c-sujet">Sujet</label>
                  <select id="c-sujet" value={form.sujet} onChange={h} name="sujet" required>
                    <option value="">Choisissez un sujet…</option>
                    <option>Prise en main de l'application</option>
                    <option>Formation des équipes</option>
                    <option>Déploiement multi-écoles</option>
                    <option>Demande d'assistance</option>
                    <option>Autre</option>
                  </select>
                </div>
                <div className="edl-field">
                  <label htmlFor="c-msg">Message</label>
                  <textarea id="c-msg" value={form.msg} onChange={h} name="msg" placeholder="Décrivez votre demande…" required />
                </div>
                <button type="submit" className="edl-btn" style={{ width: '100%' }}>
                  Envoyer le message
                </button>
              </form>
            </div>
          </div>
        </section>

        {/* ===== CTA ===== */}
        <section className="edl-cta">
          <div className="edl-watermark" aria-hidden="true">
            <img src={`${import.meta.env.BASE_URL}edulink-favicon.svg`} alt="" />
          </div>
          <div className="edl-wrap edl-cta-in" data-reveal>
            <h2>Prêt à piloter vos écoles sereinement ?</h2>
            <p>Connectez-vous avec votre code d’accès école, groupe scolaire ou Super Admin et découvrez une gestion scolaire enfin simple.</p>
            <button type="button" className="edl-btn edl-btn--lg edl-btn--gold" onClick={onEnter}>
              <Icon name="lock" size={17} /> Se connecter
            </button>
          </div>
        </section>

        {/* ===== FOOTER ===== */}
        <footer className="edl-footer" style={{ position: 'relative', overflow: 'hidden' }}>
          <div className="edl-watermark" aria-hidden="true">
            <img src={`${import.meta.env.BASE_URL}edulink-favicon.svg`} alt="" />
          </div>
          <div className="edl-footer-in" style={{ position: 'relative', zIndex: 1 }}>
            <div className="edl-footer-brand">
              <img src={`${import.meta.env.BASE_URL}edulink-favicon.svg`} alt="EduLink Pro" style={{ width: 42, height: 42, borderRadius: 9, filter: 'drop-shadow(0 4px 12px rgba(0,0,0,.35))' }} />
              <div>
                <b>EduLink Pro</b>
                <small>La plateforme intelligente de gestion scolaire</small>
              </div>
            </div>
            <div className="copy">© {new Date().getFullYear()} EduLink Pro — Built by <img src={`${import.meta.env.BASE_URL}intechsoft-logo.png`} alt="Groupe InTechSoft Enterprises" style={{ display: 'inline-block', height: 120, width: 'auto', verticalAlign: 'middle', margin: '0 10px', borderRadius: 14 }} /> <b>Groupe InTechSoft Enterprises</b></div>
          </div>
        </footer>

        <ChesterWidget dark={false} session={null} landing />
      </div>
    </>
  );
}