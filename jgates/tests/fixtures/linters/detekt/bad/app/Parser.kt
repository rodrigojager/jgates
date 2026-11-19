package app

fun parse(text: String): Int {
    try {
        return text.toInt()
    } catch (e: NumberFormatException) {
    }
    return 0
}
