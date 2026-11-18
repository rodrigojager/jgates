(ns lint-core)

(defn add-one [x]
  (let [unused 1]
    (+ x 1)))
