export type PresentationOutlinePreflight = Readonly<{
  valid: boolean;
  code: string | null;
  userMessage: string | null;
}>;

export function presentationOutlinePreflight(input: any): PresentationOutlinePreflight {
  if (input?.slideCount == null) return valid();
  const totalPages = Number(input.slideCount);
  if (!Number.isInteger(totalPages) || totalPages < 1 || totalPages > 30) {
    return invalid('presentation_input_invalid', '总页数必须是 1–30 的整数。');
  }
  const outline = Array.isArray(input.slides) ? input.slides : Array.isArray(input.outline) ? input.outline : [];
  const expectedContentPages = Math.max(0, totalPages - 1);
  if (outline.length !== expectedContentPages) {
    return invalid(
      'presentation_outline_mismatch',
      `你要求总共 ${totalPages} 页，其中封面占 1 页；请提供 ${expectedContentPages} 页正文提纲，当前是 ${outline.length} 页。系统尚未开始生成。`,
    );
  }
  return valid();
}

function valid(): PresentationOutlinePreflight {
  return Object.freeze({ valid:true, code:null, userMessage:null });
}

function invalid(code: string, userMessage: string): PresentationOutlinePreflight {
  return Object.freeze({ valid:false, code, userMessage });
}
