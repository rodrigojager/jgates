import java.net.URI;
import java.net.URL;
import java.net.http.HttpClient;
import javax.servlet.http.HttpServletRequest;
import javax.servlet.http.HttpServletResponse;
import graphql.GraphQL;
import org.springframework.web.socket.config.annotation.WebSocketHandlerRegistry;

public class WebProtocol {
    void configureHeaders(Object http) throws Exception {
        http.headers().frameOptions().disable();
    }

    void applyPolicy(HttpServletResponse res) {
        res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self' 'unsafe-inline'");
    }

    void openFeed(HttpClient client, Object listener) {
        client.newWebSocketBuilder().buildAsync(URI.create("ws://feed.example.com/live"), listener);
    }

    void registerHandlers(WebSocketHandlerRegistry registry, Object handler) {
        registry.addHandler(handler, "/ws").setAllowedOrigins("*");
    }

    GraphQL createGraphql(Object schema) {
        return GraphQL.newGraphQL(schema).build();
    }

    void redirectAfterLogin(HttpServletRequest req, HttpServletResponse res) throws Exception {
        String next = req.getParameter("next");
        res.sendRedirect(next);
    }

    String clientAddress(HttpServletRequest req) {
        return req.getHeader("X-Forwarded-For");
    }

    String resetLink(HttpServletRequest req, String token) throws Exception {
        String host = req.getHeader("Host");
        return "https://" + host + "/reset?t=" + token;
    }
}
