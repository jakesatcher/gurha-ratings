-- Remove every rating made under the earlier systems: ratings scored on separate categories
-- (Skating, Puck Skills, …), whether on the 0–11 scale or the level scale. Only ratings made with the
-- single overall rating remain. Each removed rating is copied into the audit log first, and its rater
-- can rate that player again.
INSERT INTO audit_log (actor_id, action, entity, entity_id, details)
SELECT NULL, 'rating_deleted', 'rating', r.id, jsonb_build_object(
         'reason', 'Removed automatically: made with the old category-based rating system',
         'player_id', r.player_id,
         'rater_id', r.rater_id,
         'season_id', r.season_id,
         'rated_at', r.created_at,
         'scale', CASE WHEN r.scale = 1 THEN '0-11' ELSE 'levels' END,
         'comments', r.evidence,
         'final_level', r.final_level,
         'scores', (SELECT jsonb_agg(jsonb_build_object('category', c.name, 'score', rs.score, 'grade', rs.grade, 'comment', rs.comment) ORDER BY c.sort_order)
                      FROM rating_scores rs JOIN categories c ON c.id = rs.category_id WHERE rs.rating_id = r.id))
  FROM ratings r
 WHERE r.scale = 1
    OR EXISTS (SELECT 1 FROM rating_scores rs JOIN categories c ON c.id = rs.category_id
                WHERE rs.rating_id = r.id AND c.key <> 'overall');

DELETE FROM ratings r
 WHERE r.scale = 1
    OR EXISTS (SELECT 1 FROM rating_scores rs JOIN categories c ON c.id = rs.category_id
                WHERE rs.rating_id = r.id AND c.key <> 'overall');
