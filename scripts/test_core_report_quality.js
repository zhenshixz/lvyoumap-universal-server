const assert = require('assert');
const { getQuality, matchBaselineItem } = require('./report_core_attractions');

function completeManualRecord(overrides = {}) {
  return {
    id: 'manual_test',
    name: '测试景点',
    city: '测试市',
    dataLayer: 'manual',
    image: 'https://example.com/image.jpg',
    description: '完整的景点介绍。',
    intro: '完整的景点摘要。',
    price: '以官方公告为准',
    guide_data: {
      clothing: {},
      transport: {},
      housing: [{ area: '附近', desc: '交通方便' }],
      food: ['一', '二', '三'],
      special_care: {},
    },
    lazy_ai_text: `省力路线${'与实用游览建议'.repeat(30)}`,
    lazy_ai_source: { source: 'verified', prompt: 'test', updatedAt: '2026-08-17' },
    source_evidence: { basicInfoSources: ['https://example.com/official'] },
    image_source: { sourceUrl: 'https://example.com/image', license: 'public' },
    ...overrides,
  };
}

const unreviewed = getQuality(completeManualRecord());
assert.strictEqual(unreviewed.ready, false, 'An unreviewed single-source manual record must remain incomplete.');
assert.ok(unreviewed.issues.includes('source.basicInfo'));

const reviewed = getQuality(completeManualRecord({ quality_status: { reviewRequired: true } }));
assert.strictEqual(reviewed.ready, true, 'A reviewed authoritative single-source record is a non-blocking warning.');
assert.ok(reviewed.issues.includes('source.basicInfoSingleSource'));

const approvedCountyBinding = matchBaselineItem({
  name: '暖泉古镇',
  city: '张家口',
  preferredId: 'manual_hebei_test',
}, [completeManualRecord({ id: 'manual_hebei_test', name: '暖泉古镇', city: '蔚县' })]);
assert.strictEqual(approvedCountyBinding.status, 'present', 'An approved preferredId must not be rejected because county and prefecture labels differ.');

console.log('Core report quality policy regression passed.');
