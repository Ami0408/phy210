/**
 * Parser tests for /api/grade — run with:  node api/grade.test.js
 *
 * No network, no key needed: these exercise the reply-parsing path only,
 * using the shapes real gateways have actually returned.
 */

'use strict';

process.env.GRADER_TEST = '1';
const { extractJson, coerceGrade } = require('./grade.js');

let pass = 0, fail = 0;

function check(name, fn) {
  try {
    fn();
    pass++;
    console.log('  ok   ' + name);
  } catch (e) {
    fail++;
    console.log('  FAIL ' + name + '\n       ' + e.message);
  }
}
function eq(actual, expected, what) {
  if (actual !== expected) {
    throw new Error((what || 'value') + ': expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual));
  }
}
function truthy(v, what) {
  if (!v) throw new Error((what || 'value') + ' should be truthy, got ' + JSON.stringify(v));
}
const grade = (text, marks) => coerceGrade(extractJson(text), marks);

console.log('\nclean contract reply');

check('bare JSON object', () => {
  const g = grade('{"score":3,"verdict":"partial","feedback":"Close.","modelAnswer":"M"}', 4);
  eq(g.score, 3, 'score');
  eq(g.verdict, 'partial', 'verdict');
  eq(g.feedback, 'Close.', 'feedback');
  eq(g.modelAnswer, 'M', 'modelAnswer');
});

check('fenced ```json block', () => {
  const g = grade('```json\n{"score":4,"verdict":"correct","feedback":"Good.","modelAnswer":"M"}\n```', 4);
  eq(g.score, 4, 'score');
  eq(g.verdict, 'correct', 'verdict');
});

check('prose before and after the object', () => {
  const g = grade('Sure, here is the marking:\n{"score":2,"verdict":"partial","feedback":"Half there.","modelAnswer":"M"}\nHope that helps!', 4);
  eq(g.score, 2, 'score');
});

console.log('\nthe shape that broke production (opus wrote its own schema)');

check('marks_awarded + breakdown, fenced — scores 3 not 0', () => {
  const real = '```json\n' + JSON.stringify({
    question: 'State four major applications of semiconductor diodes.',
    max_marks: 4,
    marks_awarded: 3,
    breakdown: [
      { response: 'Rectification', verdict: 'correct', marks: 1, note: 'AC to DC.' },
      { response: 'Surge protection', verdict: 'correct', marks: 1, note: 'Clamping diodes.' },
      { response: 'Amplification', verdict: 'incorrect', marks: 0, note: 'That is a transistor function.' },
      { response: 'Voltage regulation', verdict: 'correct', marks: 1, note: 'Zener in reverse breakdown.' },
    ],
    feedback: 'Three of four are right; amplification is not a diode application.',
  }, null, 2) + '\n```';
  const g = grade(real, 4);
  eq(g.score, 3, 'score');
  eq(g.verdict, 'partial', 'verdict');
  truthy(g.feedback, 'feedback');
});

check('breakdown only — marks are summed', () => {
  const g = grade(JSON.stringify({
    breakdown: [
      { point: 'a', marks: 1, note: 'yes' },
      { point: 'b', marks: 0.5, note: 'partly' },
    ],
  }), 4);
  eq(g.score, 1.5, 'summed score');
  eq(g.verdict, 'partial', 'verdict');
  truthy(g.feedback, 'feedback built from notes');
});

check('score capped at the marks available', () => {
  eq(grade('{"marks_awarded":99,"feedback":"x"}', 4).score, 4, 'capped score');
});

console.log('\nalternative key spellings and nesting');

check('camelCase / snake_case / synonyms', () => {
  const g = grade('{"Marks Awarded":2,"result":"Partially Correct","comment":"Nearly.","model_answer":"M"}', 4);
  eq(g.score, 2, 'score');
  eq(g.verdict, 'partial', 'verdict');
  eq(g.modelAnswer, 'M', 'modelAnswer');
});

check('grade nested one level down', () => {
  const g = grade('{"grading":{"score":1,"verdict":"partial","feedback":"Some of it."}}', 2);
  eq(g.score, 1, 'score');
  eq(g.feedback, 'Some of it.', 'feedback');
});

check('feedback given as an array of strings', () => {
  const g = grade('{"score":1,"feedback":["Missing the formula.","Units are wrong."]}', 3);
  eq(g.feedback, 'Missing the formula. Units are wrong.', 'joined feedback');
});

console.log('\ntruncated replies (hit the token ceiling)');

check('object cut off mid-string is repaired', () => {
  const g = grade('{"score":2,"verdict":"partial","feedback":"You got the rectification part but the Zener', 4);
  eq(g.score, 2, 'score');
  eq(g.verdict, 'partial', 'verdict');
  truthy(g.feedback.startsWith('You got the rectification'), 'partial feedback kept');
});

check('unclosed fence with complete object', () => {
  const g = grade('```json\n{"score":4,"verdict":"correct","feedback":"All four correct.","modelAnswer":"M"}', 4);
  eq(g.score, 4, 'score');
});

check('trailing comma / dangling key is trimmed', () => {
  const g = grade('{"score":1,"feedback":"Partly right.","modelAnswer":', 4);
  eq(g.score, 1, 'score');
  eq(g.feedback, 'Partly right.', 'feedback');
});

console.log('\nverdict inference');

check('verdict derived from score when absent', () => {
  eq(grade('{"score":4,"feedback":"f"}', 4).verdict, 'correct', 'full marks');
  eq(grade('{"score":2,"feedback":"f"}', 4).verdict, 'partial', 'half marks');
  eq(grade('{"score":0,"feedback":"f"}', 4).verdict, 'incorrect', 'zero');
});

check('85% threshold for correct', () => {
  eq(grade('{"score":8.5,"feedback":"f"}', 10).verdict, 'correct', '85%');
  eq(grade('{"score":8,"feedback":"f"}', 10).verdict, 'partial', '80%');
});

console.log('\nunusable replies must fail, not silently score 0');

check('pure prose returns null', () => {
  eq(grade("I don't have anything to grade yet. Send the student's answer.", 4), null, 'prose');
});

check('empty / garbage returns null', () => {
  eq(grade('', 4), null, 'empty string');
  eq(grade('not json at all', 4), null, 'garbage');
  eq(grade('{"question":"State four uses","max_marks":4}', 4), null, 'echo with no grade');
});

console.log('\n' + (fail ? 'FAILED' : 'PASSED') + ': ' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
