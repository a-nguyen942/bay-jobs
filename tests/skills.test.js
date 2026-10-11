import assert from 'node:assert/strict';
import { test } from 'node:test';
import { skillMask } from '../lib/skills.js';
test('skill detection reads title and HTML description with token boundaries', () => {
    assert.equal(skillMask('C++ Intern', '&lt;p&gt;JavaScript, Python, HTML/CSS and React&lt;/p&gt;'), 63);
    assert.equal(skillMask('Software Engineer', 'We react quickly. Java, scripting, pythonic and scssify.'), 32);
    assert.equal(skillMask('Java Engineer', 'Java, scripting, pythonic and scssify.'), 0);
    assert.equal(skillMask('Intern', 'C&#43;&#43;, Django and CSS3'), 52);
});
