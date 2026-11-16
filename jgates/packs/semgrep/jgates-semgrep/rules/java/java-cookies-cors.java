import java.util.Arrays;
import java.util.List;
import java.util.Set;
import javax.servlet.http.Cookie;
import javax.servlet.http.HttpServletRequest;
import javax.servlet.http.HttpServletResponse;
import org.apache.http.client.utils.URIBuilder;
import org.springframework.http.HttpHeaders;
import org.springframework.http.ResponseCookie;
import org.springframework.http.ResponseEntity;
import org.springframework.session.web.http.DefaultCookieSerializer;
import org.springframework.web.bind.annotation.CrossOrigin;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.cors.CorsConfiguration;
import org.springframework.web.servlet.config.annotation.CorsRegistry;
import org.springframework.web.util.UriComponentsBuilder;
import org.springframework.http.converter.json.MappingJacksonValue;
import org.springframework.web.servlet.mvc.method.annotation.AbstractJsonpResponseBodyAdvice;
import javax.ws.rs.core.NewCookie;

public class CookieSamples {
    private static final Set<String> ALLOWED = Set.of("https://app.example.com");

    void secureMissing(HttpServletResponse resp) {
        // ruleid: jgates.java.cookie-without-secure-by-default
        Cookie c = new Cookie("__Host-sid", "v");
        c.setHttpOnly(true);
        c.setAttribute("SameSite", "Lax");
        resp.addCookie(c);
    }

    void secureOff(HttpServletResponse resp) {
        Cookie c = new Cookie("__Host-sid", "v");
        // ok: jgates.java.cookie-without-secure-by-default
        // ruleid: jgates.java.cookie-without-secure
        c.setSecure(false);
        c.setHttpOnly(true);
        c.setAttribute("SameSite", "Lax");
        resp.addCookie(c);
    }

    void secureInline(HttpServletResponse resp) {
        // ruleid: jgates.java.cookie-without-secure-by-default, jgates.java.cookie-without-httponly-by-default, jgates.java.cookie-without-samesite
        resp.addCookie(new Cookie("__Host-sid", "v"));
    }

    void secureSet(HttpServletResponse resp) {
        // ok: jgates.java.cookie-without-secure, jgates.java.cookie-without-secure-by-default
        Cookie c = new Cookie("__Host-sid", "v");
        c.setSecure(true);
        c.setHttpOnly(true);
        c.setAttribute("SameSite", "Lax");
        resp.addCookie(c);
    }

    void secureSpring() {
        // ruleid: jgates.java.cookie-without-secure-by-default
        ResponseCookie a = ResponseCookie.from("__Host-sid", "v").httpOnly(true).sameSite("Lax").build();
        // ok: jgates.java.cookie-without-secure-by-default
        // ruleid: jgates.java.cookie-without-secure
        ResponseCookie b = ResponseCookie.from("__Host-sid", "v").secure(false).httpOnly(true).sameSite("Lax").build();
        // ok: jgates.java.cookie-without-secure, jgates.java.cookie-without-secure-by-default
        ResponseCookie c = ResponseCookie.from("__Host-sid", "v").secure(true).httpOnly(true).sameSite("Lax").build();
    }

    void secureSerializer(DefaultCookieSerializer s) {
        // ruleid: jgates.java.cookie-without-secure
        s.setUseSecureCookie(false);
        // ok: jgates.java.cookie-without-secure
        s.setUseSecureCookie(true);
    }

    void httpOnlyMissing(HttpServletResponse resp) {
        // ruleid: jgates.java.cookie-without-httponly-by-default
        Cookie c = new Cookie("__Host-sid", "v");
        c.setSecure(true);
        c.setAttribute("SameSite", "Lax");
        resp.addCookie(c);
    }

    void httpOnlyOff(HttpServletResponse resp) {
        Cookie c = new Cookie("__Host-sid", "v");
        c.setSecure(true);
        // ok: jgates.java.cookie-without-httponly-by-default
        // ruleid: jgates.java.cookie-without-httponly
        c.setHttpOnly(false);
        c.setAttribute("SameSite", "Lax");
        resp.addCookie(c);
    }

    void httpOnlySet(HttpServletResponse resp) {
        // ok: jgates.java.cookie-without-httponly, jgates.java.cookie-without-httponly-by-default
        Cookie c = new Cookie("__Host-sid", "v");
        c.setSecure(true);
        c.setHttpOnly(true);
        c.setAttribute("SameSite", "Lax");
        resp.addCookie(c);
    }

    void httpOnlySpring() {
        // ruleid: jgates.java.cookie-without-httponly-by-default
        ResponseCookie a = ResponseCookie.from("__Host-sid", "v").secure(true).sameSite("Lax").build();
        // ok: jgates.java.cookie-without-httponly-by-default
        // ruleid: jgates.java.cookie-without-httponly
        ResponseCookie b = ResponseCookie.from("__Host-sid", "v").secure(true).httpOnly(false).sameSite("Lax").build();
        // ok: jgates.java.cookie-without-httponly, jgates.java.cookie-without-httponly-by-default
        ResponseCookie c = ResponseCookie.from("__Host-sid", "v").secure(true).httpOnly(true).sameSite("Lax").build();
    }

    void httpOnlySerializer(DefaultCookieSerializer s) {
        // ruleid: jgates.java.cookie-without-httponly
        s.setUseHttpOnlyCookie(false);
        // ok: jgates.java.cookie-without-httponly
        s.setUseHttpOnlyCookie(true);
    }

    void sameSiteMissing(HttpServletResponse resp) {
        // ruleid: jgates.java.cookie-without-samesite
        Cookie c = new Cookie("__Host-sid", "v");
        c.setSecure(true);
        c.setHttpOnly(true);
        resp.addCookie(c);
    }

    void sameSiteNone(HttpServletResponse resp) {
        Cookie c = new Cookie("__Host-sid", "v");
        c.setSecure(true);
        c.setHttpOnly(true);
        // ruleid: jgates.java.cookie-without-samesite
        c.setAttribute("SameSite", "None");
        resp.addCookie(c);
    }

    void sameSiteStrict(HttpServletResponse resp) {
        // ok: jgates.java.cookie-without-samesite
        Cookie c = new Cookie("__Host-sid", "v");
        c.setSecure(true);
        c.setHttpOnly(true);
        c.setAttribute("SameSite", "Strict");
        resp.addCookie(c);
    }

    void sameSiteSpring() {
        // ruleid: jgates.java.cookie-without-samesite
        ResponseCookie a = ResponseCookie.from("__Host-sid", "v").secure(true).httpOnly(true).build();
        // ruleid: jgates.java.cookie-without-samesite
        ResponseCookie b = ResponseCookie.from("__Host-sid", "v").secure(true).httpOnly(true).sameSite("None").build();
        // ok: jgates.java.cookie-without-samesite
        ResponseCookie c = ResponseCookie.from("__Host-sid", "v").secure(true).httpOnly(true).sameSite("Strict").build();
    }

    void sameSiteSerializer(DefaultCookieSerializer s) {
        // ruleid: jgates.java.cookie-without-samesite
        s.setSameSite("None");
        // ok: jgates.java.cookie-without-samesite
        s.setSameSite("Lax");
    }

    void prefixLiteral(HttpServletResponse resp) {
        // ruleid: jgates.java.cookie-name-without-prefix
        Cookie c = new Cookie("sid", "v");
        c.setSecure(true);
        c.setHttpOnly(true);
        c.setAttribute("SameSite", "Lax");
        resp.addCookie(c);
    }

    void prefixSpring() {
        // ruleid: jgates.java.cookie-name-without-prefix
        ResponseCookie a = ResponseCookie.from("sid", "v").secure(true).httpOnly(true).sameSite("Lax").build();
        // ruleid: jgates.java.cookie-name-without-prefix
        NewCookie b = new NewCookie("sid", "v");
    }

    void prefixSerializer(DefaultCookieSerializer s) {
        // ruleid: jgates.java.cookie-name-without-prefix
        s.setCookieName("SESSION");
        // ok: jgates.java.cookie-name-without-prefix
        s.setCookieName("__Host-SESSION");
    }

    void prefixOk(HttpServletResponse resp, String name) {
        // ok: jgates.java.cookie-name-without-prefix
        Cookie a = new Cookie("__Host-sid", "v");
        a.setSecure(true);
        a.setHttpOnly(true);
        a.setAttribute("SameSite", "Lax");
        // ok: jgates.java.cookie-name-without-prefix
        Cookie b = new Cookie("__Secure-pref", "v");
        b.setSecure(true);
        b.setHttpOnly(true);
        b.setAttribute("SameSite", "Lax");
        // ok: jgates.java.cookie-name-without-prefix
        Cookie c = new Cookie(name, "v");
        c.setSecure(true);
        c.setHttpOnly(true);
        c.setAttribute("SameSite", "Lax");
    }

    void corsAnyChain(CorsRegistry registry) {
        // ruleid: jgates.java.cors-any-origin-with-credentials
        registry.addMapping("/api/**").allowedOrigins("*").allowCredentials(true);
        // ruleid: jgates.java.cors-any-origin-with-credentials
        registry.addMapping("/api/**").allowedOriginPatterns("*").allowCredentials(true);
        // ok: jgates.java.cors-any-origin-with-credentials
        registry.addMapping("/api/**").allowedOrigins("https://app.example.com").allowCredentials(true);
        // ok: jgates.java.cors-any-origin-with-credentials
        registry.addMapping("/public/**").allowedOrigins("*").allowCredentials(false);
    }

    CorsConfiguration corsAnyConfig() {
        CorsConfiguration config = new CorsConfiguration();
        config.setAllowCredentials(true);
        // ruleid: jgates.java.cors-any-origin-with-credentials
        config.addAllowedOrigin("*");
        return config;
    }

    CorsConfiguration corsAnyList() {
        CorsConfiguration config = new CorsConfiguration();
        config.setAllowCredentials(true);
        // ruleid: jgates.java.cors-any-origin-with-credentials
        config.setAllowedOrigins(Arrays.asList("*"));
        return config;
    }

    CorsConfiguration corsListed() {
        CorsConfiguration config = new CorsConfiguration();
        config.setAllowCredentials(true);
        // ok: jgates.java.cors-any-origin-with-credentials
        config.addAllowedOrigin("https://app.example.com");
        return config;
    }

    // ruleid: jgates.java.cors-any-origin-with-credentials
    @CrossOrigin(origins = "*", allowCredentials = "true")
    String annotatedAny() {
        return "ok";
    }

    // ok: jgates.java.cors-any-origin-with-credentials
    @CrossOrigin(origins = "https://app.example.com", allowCredentials = "true")
    String annotatedListed() {
        return "ok";
    }

    void corsAnyHeader(HttpServletResponse resp) {
        // ruleid: jgates.java.cors-any-origin-with-credentials
        resp.setHeader("Access-Control-Allow-Origin", "*");
        resp.setHeader("Access-Control-Allow-Credentials", "true");
    }

    void corsListedHeader(HttpServletResponse resp) {
        // ok: jgates.java.cors-any-origin-with-credentials
        resp.setHeader("Access-Control-Allow-Origin", "https://app.example.com");
        resp.setHeader("Access-Control-Allow-Credentials", "true");
    }

    void reflectHeader(HttpServletRequest req, HttpServletResponse resp) {
        String origin = req.getHeader("Origin");
        // ruleid: jgates.java.cors-origin-reflected
        resp.setHeader("Access-Control-Allow-Origin", origin);
    }

    void reflectSpring(@RequestHeader("Origin") String origin, HttpHeaders headers) {
        // ruleid: jgates.java.cors-origin-reflected
        headers.set(HttpHeaders.ACCESS_CONTROL_ALLOW_ORIGIN, origin);
    }

    void reflectConfig(HttpServletRequest req, CorsConfiguration config) {
        // ruleid: jgates.java.cors-origin-reflected
        config.addAllowedOrigin(req.getHeader("Origin"));
    }

    void reflectChecked(HttpServletRequest req, HttpServletResponse resp) {
        String origin = req.getHeader("Origin");
        if (ALLOWED.contains(origin)) {
            // ok: jgates.java.cors-origin-reflected
            resp.setHeader("Access-Control-Allow-Origin", origin);
        }
    }

    void reflectConstant(HttpServletRequest req, HttpServletResponse resp) {
        String origin = req.getHeader("Origin");
        // ok: jgates.java.cors-origin-reflected
        resp.setHeader("Access-Control-Allow-Origin", "https://app.example.com");
    }

    void jsonpFunction(MappingJacksonValue value) {
        // ruleid: jgates.java.jsonp-enabled
        value.setJsonpFunction("handle");
    }

    // ruleid: jgates.java.jsonp-enabled
    class JsonpAdvice extends AbstractJsonpResponseBodyAdvice {
        JsonpAdvice() {
            super("callback");
        }
    }

    MappingJacksonValue plainValue(Object body) {
        // ok: jgates.java.jsonp-enabled
        MappingJacksonValue value = new MappingJacksonValue(body);
        return value;
    }

    ResponseEntity<Object> plainJson(Object body) {
        // ok: jgates.java.jsonp-enabled
        return ResponseEntity.ok(body);
    }

    void callbackWriter(HttpServletRequest req, HttpServletResponse resp, String json) throws Exception {
        String cb = req.getParameter("callback");
        // ruleid: jgates.java.jsonp-enabled-callback
        resp.getWriter().write(cb + "(" + json + ")");
    }

    ResponseEntity<String> callbackEntity(@RequestParam("callback") String callback, String body) {
        // ruleid: jgates.java.jsonp-enabled-callback
        return ResponseEntity.ok(callback + "(" + body + ")");
    }

    void callbackChecked(HttpServletRequest req, HttpServletResponse resp, String json) throws Exception {
        String cb = req.getParameter("callback");
        if (cb.matches("[A-Za-z_][A-Za-z0-9_]*")) {
            // ok: jgates.java.jsonp-enabled-callback
            resp.getWriter().write(cb + "(" + json + ")");
        }
    }

    void callbackPlain(HttpServletRequest req, HttpServletResponse resp, String json) throws Exception {
        String cb = req.getParameter("callback");
        // ok: jgates.java.jsonp-enabled-callback
        resp.getWriter().write(json);
    }

    String queryLiteral(String key, String pw) {
        // ruleid: jgates.java.sensitive-query-parameter
        String a = "https://api.example.com/v1/items?api_key=" + key;
        // ruleid: jgates.java.sensitive-query-parameter
        String b = "https://example.com/login?user=ana&password=" + pw;
        // ok: jgates.java.sensitive-query-parameter
        String c = "https://api.example.com/v1/items?page=2&sort=name";
        return a + b + c;
    }

    void queryBuilders(String base, String secret) throws Exception {
        // ruleid: jgates.java.sensitive-query-parameter
        UriComponentsBuilder.fromUriString(base).queryParam("password", secret);
        URIBuilder builder = new URIBuilder(base);
        // ruleid: jgates.java.sensitive-query-parameter
        builder.addParameter("secret", secret);
        // ok: jgates.java.sensitive-query-parameter
        UriComponentsBuilder.fromUriString(base).queryParam("page", 2);
        // ok: jgates.java.sensitive-query-parameter
        builder.addParameter("page", "2");
    }
}
