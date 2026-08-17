const { normalizeAttractionName, probablySameAttraction } = require('./generate_static_data');

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function normalizedEvidenceUrl(value) {
  const raw = String(value || '').split(/：(?=https?:\/\/)/).pop().trim();
  try {
    const url = new URL(raw);
    const host = url.hostname.toLowerCase();
    if (/you\.ctrip\.com$/.test(host) && /\/sight\//.test(url.pathname)) return `${host}${url.pathname}`.toLowerCase();
    if (/amap\.com$/.test(host) && /\/place\//.test(url.pathname)) return `${host}${url.pathname}`.toLowerCase();
    if (/trip\.com$/.test(host) && url.pathname.length > 8) return `${host}${url.pathname}`.toLowerCase();
    if (/\/site\/special\/province/i.test(url.pathname) || /\/sightlist\//i.test(url.pathname)) return '';
    return '';
  } catch {
    return '';
  }
}

function strongEvidenceKeys(item) {
  const values = [
    ...(item?.source_evidence?.basicInfoSources || []),
    item?.source_evidence?.ratingSource?.url,
    item?.image_source?.sourceUrl,
  ];
  return new Set(values.map(normalizedEvidenceUrl).filter(Boolean));
}

function sharesStrongEvidence(left, right) {
  const leftKeys = strongEvidenceKeys(left);
  return [...strongEvidenceKeys(right)].some(key => leftKeys.has(key));
}

function itemScore(item) {
  return String(item?.name || '').length * 4
    + (item?.lazy_routes?.length || 0) * 12
    + (item?.source_evidence?.basicInfoSources?.length || 0) * 3
    + (item?.image && !/default-thumbnail/.test(item.image) ? 8 : 0);
}

function mergeArrays(primary, secondary, key) {
  const values = [...(primary || []), ...(secondary || [])];
  if (key === 'lazy_routes') {
    return [...new Map(values.map(value => [value?.title || JSON.stringify(value), value])).values()];
  }
  if (values.every(value => typeof value === 'string')) return [...new Set(values)];
  return primary?.length ? primary : secondary;
}

function fillMissing(primary, secondary, key = '') {
  if (primary === undefined || primary === null || primary === '') return clone(secondary);
  if (Array.isArray(primary) && Array.isArray(secondary)) return mergeArrays(primary, secondary, key);
  if (primary && secondary && typeof primary === 'object' && typeof secondary === 'object'
    && !Array.isArray(primary) && !Array.isArray(secondary)) {
    const result = clone(primary);
    for (const [childKey, value] of Object.entries(secondary)) {
      result[childKey] = fillMissing(result[childKey], value, childKey);
    }
    return result;
  }
  return primary;
}

function mergeDuplicatePair(left, right) {
  const primary = itemScore(left) >= itemScore(right) ? left : right;
  const secondary = primary === left ? right : left;
  const merged = fillMissing(primary, secondary);
  merged.id = primary.id;
  merged.name = primary.name;
  merged.self_heal = {
    ...(merged.self_heal || {}),
    mergedDuplicateIds: [...new Set([...(merged.self_heal?.mergedDuplicateIds || []), secondary.id].filter(Boolean))],
    mergedAliases: [...new Set([...(merged.self_heal?.mergedAliases || []), secondary.name].filter(Boolean))],
    reason: '同省近似名称且共享同一 OTA/高德实体来源，自动合并',
  };
  return { merged, removed: secondary };
}

function healPackageDuplicates(packageData) {
  const additions = (packageData?.attractions || []).map(clone);
  const healed = [];
  const actions = [];
  for (const item of additions) {
    const index = healed.findIndex(existing => (
      probablySameAttraction(existing.name, item.name)
      && String(existing.city || '') === String(item.city || '')
      && sharesStrongEvidence(existing, item)
    ));
    if (index < 0) {
      healed.push(item);
      continue;
    }
    const { merged, removed } = mergeDuplicatePair(healed[index], item);
    healed[index] = merged;
    actions.push({
      type: 'merge_duplicate_additions',
      keptId: merged.id,
      keptName: merged.name,
      removedId: removed.id,
      removedName: removed.name,
      reason: merged.self_heal.reason,
    });
  }
  return {
    packageData: { ...packageData, attractions: healed },
    actions,
  };
}

function healAdditionsAgainstExisting(packageData, provinceData) {
  const additions = [];
  const overrides = clone(packageData?.overrides || {});
  const actions = [];
  for (const item of packageData?.attractions || []) {
    const existing = (provinceData?.attractions || []).find(candidate => {
      if (candidate.id && candidate.id === item.id) return true;
      if (String(candidate.city || '') !== String(item.city || '')) return false;
      const exactName = normalizeAttractionName(candidate.name) === normalizeAttractionName(item.name);
      return exactName || (probablySameAttraction(candidate.name, item.name) && sharesStrongEvidence(candidate, item));
    });
    if (!existing) {
      additions.push(clone(item));
      continue;
    }
    const patch = clone(item);
    const originalId = patch.id;
    patch.id = existing.id;
    overrides[existing.id] = fillMissing(patch, overrides[existing.id] || {});
    actions.push({
      type: 'convert_addition_to_override',
      keptId: existing.id,
      keptName: patch.name,
      removedId: originalId,
      removedName: item.name,
      reason: '现有库已存在同实体记录，自动转换为增强覆盖',
    });
  }
  return {
    packageData: { ...packageData, attractions: additions, overrides },
    actions,
  };
}

module.exports = {
  healPackageDuplicates,
  healAdditionsAgainstExisting,
  normalizedEvidenceUrl,
  sharesStrongEvidence,
};
