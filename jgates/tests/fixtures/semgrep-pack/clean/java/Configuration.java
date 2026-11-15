import com.fasterxml.jackson.annotation.JsonAutoDetect.Visibility;
import com.fasterxml.jackson.annotation.PropertyAccessor;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.util.Map;
import javax.servlet.http.HttpServletRequest;
import javax.servlet.http.HttpServletResponse;
import org.apache.commons.beanutils.BeanUtils;

public class Configuration {
    void startup(Object http, Object files, Object context, Object serverConfig) {
        System.setProperty("debug", "false");
        http.authorizeRequests().requestMatchers("/actuator/**").hasRole("ADMIN");
        files.setDirectoriesListed(false);
        serverConfig.setSendServerVersion(false);
    }

    void updateUser(HttpServletRequest req, HttpServletResponse resp, Object user) throws Exception {
        resp.setHeader("Content-Type", "text/html");
        BeanUtils.populate(user, Map.of("name", req.getParameter("name")));
    }

    ObjectMapper mapper() {
        ObjectMapper mapper = new ObjectMapper();
        mapper.setVisibility(PropertyAccessor.FIELD, Visibility.NONE);
        return mapper;
    }
}
