/**
 * 右侧对象面板：字段 / 索引 / 外键 / DDL 四个分段。
 * 未选中对象时只显示一句引导文案，不占版面。
 */

import { useEffect, useState } from 'react';
import { api, errMessage } from '@/services/ipc';
import { useAppStore } from '@/store';
import type { DdlResult, ForeignKeyMeta, IndexMeta } from '@/types';
import s from './Inspector.module.css';

type Section = 'columns' | 'indexes' | 'fks' | 'ddl';

const SECTIONS: { key: Section; label: string }[] = [
  { key: 'columns', label: '字段' },
  { key: 'indexes', label: '索引' },
  { key: 'fks', label: '外键' },
  { key: 'ddl', label: 'DDL' },
];

export function Inspector() {
  const st = useAppStore();
  const active = st.tabs.find((t) => t.key === st.activeKey) ?? null;
  const section = st.inspectorSection;
  const setSection = st.setInspectorSection;
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [indexes, setIndexes] = useState<IndexMeta[]>([]);
  const [fks, setFks] = useState<ForeignKeyMeta[]>([]);
  const [referencedBy, setReferencedBy] = useState<ForeignKeyMeta[]>([]);
  const [ddl, setDdl] = useState<DdlResult | null>(null);

  useEffect(() => {
    if (!active) return;
    if (section === 'columns') return;
    let ignore = false;
    setLoading(true);
    setError(null);
    // 切换对象 / 分段时先清空对应旧数据，避免上一张表的内容短暂残留
    if (section === 'indexes') setIndexes([]);
    if (section === 'fks') {
      setFks([]);
      setReferencedBy([]);
    }
    if (section === 'ddl') setDdl(null);
    const connId = active.connId;
    const node = active.node;
    const task =
      section === 'indexes'
        ? api.indexes(connId, node).then((v) => {
            if (!ignore) setIndexes(v);
          })
        : section === 'fks'
          ? Promise.all([
              api.foreignKeys(connId, node).then((v) => {
                if (!ignore) setFks(v);
              }),
              api.referencedBy(connId, node).then((v) => {
                if (!ignore) setReferencedBy(v);
              }),
            ])
          : api.ddl(connId, node).then((v) => {
              if (!ignore) setDdl(v);
            });
    task
      .catch((e: unknown) => {
        if (!ignore) setError(errMessage(e));
      })
      .finally(() => {
        if (!ignore) setLoading(false);
      });
    return () => {
      ignore = true;
    };
  }, [active?.key, section]);

  if (!active) {
    return (
      <aside className={s.inspector}>
        <div className={s.emptyOnly}>
          <p className={s.hint}>在左侧选择一张表，这里会显示它的字段、索引与建表语句。</p>
        </div>
      </aside>
    );
  }

  return (
    <aside className={s.inspector}>
      <div className={s.head}>
        <div className={s.title}>{active.title}</div>
        <div className={s.sub}>
          {active.connName} · {active.columns.length} 个字段
        </div>
      </div>
      <div className={s.tabs}>
        {SECTIONS.map((x) => (
          <button
            key={x.key}
            className={x.key === section ? s.tabBtnOn : s.tabBtn}
            onClick={() => setSection(x.key)}
          >
            {x.label}
          </button>
        ))}
      </div>
      <div className={s.body}>
        {loading ? <p className={s.hint}>读取中…</p> : null}
        {error ? <p className={s.err}>{error}</p> : null}

        {section === 'columns' ? (
          <>
            {active.columnsLoading ? <p className={s.hint}>正在读取表结构…</p> : null}
            {!active.columnsLoading && active.columns.length === 0 ? (
              <p className={s.hint}>没有取到字段信息</p>
            ) : null}
            <div className={s.cols}>
              {active.columns.map((c) => (
                <div key={c.name} className={s.col} title={c.comment || c.name}>
                  <div className={s.colTop}>
                    <span className={s.colName}>{c.name}</span>
                    {c.primaryKey ? <span className={s.pk}>PK</span> : null}
                    {c.nullable ? null : <span className={s.req}>NOT NULL</span>}
                  </div>
                  <div className={s.colType}>{c.typeName}</div>
                  {c.defaultValue ? <div className={s.colDefault}>默认 {c.defaultValue}</div> : null}
                </div>
              ))}
            </div>
          </>
        ) : null}

        {section === 'indexes' && !loading ? (
          indexes.length === 0 ? (
            <p className={s.hint}>这张表没有索引</p>
          ) : (
            <div className={s.list}>
              {indexes.map((i) => (
                <div key={i.name} className={s.item}>
                  <div className={s.itemTop}>
                    <span className={s.itemName}>{i.name}</span>
                    {i.primary ? <span className={s.pk}>PK</span> : null}
                    {i.unique && !i.primary ? <span className={s.uniq}>唯一</span> : null}
                  </div>
                  <div className={s.itemSub}>{i.columns.join(', ')}</div>
                  {i.method ? <div className={s.itemSub}>方法 {i.method}</div> : null}
                </div>
              ))}
            </div>
          )
        ) : null}

        {section === 'fks' && !loading ? (
          <>
            <div className={s.groupLabel}>本表引用</div>
            {fks.length === 0 ? (
              <p className={s.hint}>没有引用其他表的外键</p>
            ) : (
              <div className={s.list}>
                {fks.map((f) => (
                  <div key={f.name} className={s.item}>
                    <div className={s.itemTop}>
                      <span className={s.itemName}>{f.name}</span>
                    </div>
                    <div className={s.itemSub}>
                      {f.columns.join(', ')} → {f.refTable}({f.refColumns.join(', ')})
                    </div>
                    {f.onDelete ? <div className={s.itemSub}>ON DELETE {f.onDelete}</div> : null}
                  </div>
                ))}
              </div>
            )}

            <div className={s.groupLabel}>被其他表引用</div>
            {referencedBy.length === 0 ? (
              <p className={s.hint}>没有表引用本表</p>
            ) : (
              <div className={s.list}>
                {referencedBy.map((f) => (
                  <div key={f.name} className={s.item}>
                    <div className={s.itemTop}>
                      <span className={s.itemName}>{f.name}</span>
                    </div>
                    <div className={s.itemSub}>
                      {f.refTable}({f.columns.join(', ')}) → 本表 {f.refColumns.join(', ')}
                    </div>
                    {f.onDelete ? <div className={s.itemSub}>ON DELETE {f.onDelete}</div> : null}
                  </div>
                ))}
              </div>
            )}
          </>
        ) : null}

        {section === 'ddl' && !loading && ddl ? (
          <div className={s.ddlWrap}>
            {ddl.generated ? (
              <p className={s.note}>由字段元数据生成（PostgreSQL 没有 SHOW CREATE TABLE）</p>
            ) : null}
            <pre className={s.pre}>{ddl.sql}</pre>
            <button
              className={s.copyBtn}
              onClick={() => {
                void navigator.clipboard
                  .writeText(ddl.sql)
                  .then(() => st.notify('DDL 已复制'))
                  .catch(() => st.notify('复制失败'));
              }}
            >
              复制 DDL
            </button>
          </div>
        ) : null}
      </div>
    </aside>
  );
}
