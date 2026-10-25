-- One overall rating per player instead of six weighted categories (Skating, Puck Skills, …).
-- The six categories are kept (inactive) so older ratings can still show what they recorded.
ALTER TABLE rating_scores ALTER COLUMN score TYPE numeric(5,2);

INSERT INTO categories (key, name, weight, sort_order, considerations, key_question, note, guide, active)
VALUES (
  'overall', 'Overall rating', 100, 0,
  ARRAY['Skating: speed, edges, stops, transitions, backward skating',
        'Puck skills: stickhandling, protection, handling pressure',
        'Passing & receiving',
        'Shooting',
        'Hockey IQ / awareness: positioning, reads, decisions',
        'Game execution: what actually shows up in games'],
  'What level does this player consistently demonstrate during actual game play?',
  NULL, '[]', true
)
ON CONFLICT (key) DO UPDATE SET active = true, weight = 100;

-- Ratings already made on the level scale keep their result: their weighted overall becomes the single
-- overall score (no Low/Medium/High pick is stored for these, only the points).
INSERT INTO rating_scores (rating_id, category_id, score, grade)
SELECT r.id, (SELECT id FROM categories WHERE key = 'overall'),
       round(sum(rs.score * c.weight) / nullif(sum(c.weight), 0), 2), NULL
  FROM ratings r
  JOIN rating_scores rs ON rs.rating_id = r.id
  JOIN categories c ON c.id = rs.category_id AND c.active AND c.key <> 'overall'
 WHERE r.scale = 2
 GROUP BY r.id
ON CONFLICT DO NOTHING;

UPDATE categories SET active = false WHERE key <> 'overall';
