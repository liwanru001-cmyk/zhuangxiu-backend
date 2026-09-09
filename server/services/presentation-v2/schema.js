'use strict';
const Ajv = require('ajv');
const color = { type: 'string', pattern: '^#[0-9A-Fa-f]{6}$' };
const num = (minimum, maximum) => ({ type: 'number', minimum, maximum });
const str = maxLength => ({ type: 'string', minLength: 1, maxLength });
const object = (properties, required) => ({ type: 'object', additionalProperties: false, properties, required });
const base = { id: str(80), type: {}, x: num(0, 14), y: num(0, 8), w: num(0, 14), h: num(0, 8), opacity: num(0, 1), rotation: num(-360, 360) };
const stroke = object({ color, width: num(0, 20), opacity: num(0, 1) }, ['color', 'width']);
function element(type, properties, required) {
  return object({ ...base, type: { const: type }, ...properties }, ['id', 'type', 'x', 'y', 'w', 'h', ...required]);
}
function createSchema(limits) {
  const slide = object({
    id: str(80), type: str(80), space_id: { type: ['integer', 'null'] }, design_intent: str(2000), background_color: color,
    elements: { type: 'array', minItems: 1, maxItems: limits.maxElements, items: { oneOf: [
      element('text', { role: { enum: ['title', 'subtitle', 'body', 'caption', 'product', 'decoration'] }, text: str(8000),
        font_family: str(100), font_size: num(6, 160), font_weight: { enum: ['normal', 'bold'] }, color,
        align: { enum: ['left', 'center', 'right'] }, vertical_align: { enum: ['top', 'middle', 'bottom'] },
        line_spacing: num(6, 220), paragraph_spacing: num(0, 100), margin: num(0, 36), max_lines: { type: 'integer', minimum: 1, maximum: 100 },
      }, ['text', 'font_size', 'color', 'role']),
      element('image', { asset_id: str(250), fit: { enum: ['contain', 'cover'] } }, ['asset_id', 'fit']),
      element('shape', { role: { enum: ['background', 'decoration'] }, shape_type: { enum: ['rect', 'roundRect', 'ellipse', 'triangle'] }, fill: color, stroke }, ['shape_type', 'fill']),
      element('line', { color, width: num(0.1, 20) }, ['color', 'width']),
    ] } },
  }, ['id', 'design_intent', 'elements']);
  return object({ schema_version: { const: 2 }, presentation: object({ title: str(200), design_concept: str(2000), visual_direction: str(2000), background_color: color, primary_color: color, accent_color: color }, ['title', 'design_concept', 'visual_direction', 'background_color']), slides: { type: 'array', minItems: 1, maxItems: limits.maxSlides, items: slide } }, ['schema_version', 'presentation', 'slides']);
}
function compile(limits) { const schema = createSchema(limits); return { schema, validate: new Ajv({ allErrors: true, strictNumbers: true }).compile(schema) }; }
module.exports = { createSchema, compile };
