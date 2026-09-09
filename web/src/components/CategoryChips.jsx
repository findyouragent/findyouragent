import { CATEGORIES } from '../config.js';
import { useI18n } from '../i18n/index.jsx';
import Select from './ui/select.jsx';

/**
 * The labelled selector keeps all supported categories reachable in one
 * interaction while the coverage grid gives measured categories their context.
 */
export default function CategoryChips({ active, onSelect }) {
  const { t } = useI18n();
  return (
    <label className="category-select">
      <span className="micro-label">{t('category')}</span>
      <Select
        value={active}
        onChange={onSelect}
        label={t('agent category')}
        options={CATEGORIES.map((cat) => ({ value: cat.key, label: t(cat.label) }))}
      />
    </label>
  );
}
