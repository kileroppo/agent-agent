import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { html, raw, escapeHtml } from '../public/html.js';

describe('escapeHtml', () => {
    it('escapes & < > " and single quote', () => {
        assert.equal(escapeHtml('&<>"\''), '&amp;&lt;&gt;&quot;&#39;');
    });

    it('returns empty string for null', () => {
        assert.equal(escapeHtml(null), '');
    });

    it('returns empty string for undefined', () => {
        assert.equal(escapeHtml(undefined), '');
    });

    it('converts numbers to string', () => {
        assert.equal(escapeHtml(42), '42');
    });

    it('passes through safe strings unchanged', () => {
        assert.equal(escapeHtml('hello world'), 'hello world');
    });
});

describe('raw', () => {
    it('returns an object with the value', () => {
        const result = raw('<b>bold</b>');
        assert.equal(result.value, '<b>bold</b>');
    });

    it('handles null by returning empty string value', () => {
        const result = raw(null);
        assert.equal(result.value, '');
    });

    it('handles undefined by returning empty string value', () => {
        const result = raw(undefined);
        assert.equal(result.value, '');
    });
});

describe('html tagged template', () => {
    it('auto-escapes interpolated values', () => {
        const userInput = '<script>alert("xss")</script>';
        const result = html`<div>${userInput}</div>`;
        assert.equal(result, '<div>&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;</div>');
    });

    it('does not escape static template parts', () => {
        const result = html`<div class="test"><span>hello</span></div>`;
        assert.equal(result, '<div class="test"><span>hello</span></div>');
    });

    it('passes raw values through without escaping', () => {
        const preBuilt = '<strong>safe</strong>';
        const result = html`<div>${raw(preBuilt)}</div>`;
        assert.equal(result, '<div><strong>safe</strong></div>');
    });

    it('handles null interpolation as empty string', () => {
        const result = html`<span>${null}</span>`;
        assert.equal(result, '<span></span>');
    });

    it('handles undefined interpolation as empty string', () => {
        const result = html`<span>${undefined}</span>`;
        assert.equal(result, '<span></span>');
    });

    it('handles multiple interpolations', () => {
        const name = 'Alice & Bob';
        const role = '<admin>';
        const result = html`<p>${name} - ${role}</p>`;
        assert.equal(result, '<p>Alice &amp; Bob - &lt;admin&gt;</p>');
    });

    it('mixes raw and escaped values', () => {
        const icon = '<svg>icon</svg>';
        const label = 'A & B';
        const result = html`<div>${raw(icon)}<span>${label}</span></div>`;
        assert.equal(result, '<div><svg>icon</svg><span>A &amp; B</span></div>');
    });

    it('handles nested template results (strings)', () => {
        const inner = html`<em>${'nested & value'}</em>`;
        const result = html`<div>${raw(inner)}</div>`;
        assert.equal(result, '<div><em>nested &amp; value</em></div>');
    });

    it('escapes attribute values', () => {
        const value = '" onclick="hack()';
        const result = html`<input value="${value}">`;
        assert.equal(result, '<input value="&quot; onclick=&quot;hack()">');
    });

    it('handles numbers without mangling', () => {
        const count = 42;
        const result = html`<span>${count} items</span>`;
        assert.equal(result, '<span>42 items</span>');
    });

    it('handles zero correctly', () => {
        const result = html`<span>${0}</span>`;
        assert.equal(result, '<span>0</span>');
    });

    it('handles empty string', () => {
        const result = html`<span>${''}</span>`;
        assert.equal(result, '<span></span>');
    });

    it('handles boolean false', () => {
        const result = html`<span>${false}</span>`;
        assert.equal(result, '<span>false</span>');
    });
});
