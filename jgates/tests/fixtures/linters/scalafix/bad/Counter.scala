object Counter {
  def count(items: List[Int]): Int = {
    var total = 0
    for (item <- items) total += item
    total
  }
}
