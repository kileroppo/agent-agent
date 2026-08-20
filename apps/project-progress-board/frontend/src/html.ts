const RAW_MARKER: unique symbol = Symbol('html-raw');

interface RawHtml {
    [RAW_MARKER]: true;
    value: string;
}

export function escapeHtml(value: any): string {
    return String(value ?? '').replace(/[&<>"']/g, (char: any): any => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
    } as Record<string, string>)[char]);
}

export function raw(value: any): RawHtml {
    return { [RAW_MARKER]: true, value: String(value ?? '') };
}

export function html(strings: TemplateStringsArray, ...values: any[]): string {
    let result: string = strings[0];
    for (let i: number = 0; i < values.length; i += 1) {
        const value: any = values[i];
        if (value != null && typeof value === 'object' && RAW_MARKER in value) {
            result += (value as RawHtml).value;
        } else {
            result += escapeHtml(value);
        }
        result += strings[i + 1];
    }
    return result;
}
